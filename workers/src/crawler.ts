import * as cheerio from 'cheerio';
import { CrawlConfig, type CrawlSummary } from '@siteguard/contracts';
import { prisma } from '@siteguard/database';
import { isInScope } from '@siteguard/safety';
import { audit, errMessage, isCancelled, progress, saveFindings, sleep, type FindingInput, type RunnerResult, type RunWithTarget } from './common';
import { safeFetch } from './http';
import { launchBrowser, renderHtml } from './render';

function normalise(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
}

const chainText = (chain: { url: string; status: number }[]) => chain.map((h) => `${h.status} ${h.url}`).join('\n');

export async function runCrawl(run: RunWithTarget): Promise<RunnerResult> {
  const { target } = run;
  const cfg = CrawlConfig.parse(run.config);
  const delay = Math.ceil(1000 / cfg.rps);
  const start = normalise(cfg.startPath, target.baseUrl)!;

  const queue: { url: string; depth: number; foundOn?: string }[] = [{ url: start, depth: 0 }];
  const queued = new Set([start]);
  const findings: FindingInput[] = [];
  const pageRows: {
    runId: string; url: string; status: number | null; depth: number; title: string | null; description: string | null;
    loadMs: number | null; redirectChain: object; foundOn: string | null; issues: string[];
  }[] = [];
  let crawled = 0;
  let cancelled = false;
  const browser = cfg.renderJs ? await launchBrowser() : null;

  try {
  while (queue.length && crawled < cfg.maxPages) {
    if (await isCancelled(run.id)) {
      cancelled = true;
      break;
    }
    const item = queue.shift()!;
    const issues: string[] = [];
    const linkedFrom = item.foundOn ? ` Linked from ${item.foundOn}.` : '';
    let status: number | null = null;
    let title: string | null = null;
    let description: string | null = null;
    let loadMs: number | null = null;
    let chain: { url: string; status: number }[] = [];

    try {
      const res = await safeFetch(item.url, target);
      status = res.status;
      loadMs = res.ms;
      chain = res.chain;
      const redirects = res.chain.filter((h) => h.status >= 300 && h.status < 400).length;
      if (redirects >= 2) {
        issues.push(`redirect chain (${redirects} hops)`);
        findings.push({ source: 'CRAWLER', severity: 'LOW', title: 'Redirect chain', url: item.url,
          description: `${item.url} goes through ${redirects} redirects before reaching ${res.finalUrl}.`,
          evidence: chainText(res.chain),
          remediation: 'Link directly to the final URL and collapse redirect chains into a single hop.' });
      }
      if (res.loop) {
        issues.push('redirect loop');
        findings.push({ source: 'CRAWLER', severity: 'HIGH', title: 'Redirect loop', url: item.url,
          description: `${item.url} redirects back to a URL it already visited.`, evidence: chainText(res.chain),
          remediation: 'Fix the redirect rules so the chain terminates at a 200 page.' });
      }
      if (res.blockedRedirect) {
        issues.push('redirects out of scope');
        findings.push({ source: 'CRAWLER', severity: 'INFO', title: 'Redirect leaves approved scope', url: item.url,
          description: `${item.url} redirects to ${res.blockedRedirect}, which is outside this target's approved hosts. It was not followed.`,
          remediation: 'Add the host to the target\'s extra hosts if it is part of your site, otherwise ignore.' });
      }
      if (res.status >= 500) {
        issues.push(`server error (${res.status})`);
        findings.push({ source: 'CRAWLER', severity: 'HIGH', title: `Server error ${res.status}`, url: item.url,
          description: `${item.url} returned HTTP ${res.status}.${linkedFrom}`,
          remediation: 'Check server logs for the failing request and fix the underlying exception.' });
      } else if (res.status >= 400) {
        issues.push(`broken link (${res.status})`);
        findings.push({ source: 'CRAWLER', severity: 'MEDIUM', title: `Broken link (${res.status})`, url: item.url,
          description: `${item.url} returned HTTP ${res.status}.${linkedFrom}`,
          remediation: 'Fix the link, restore the page, or add a redirect to the correct destination.' });
      } else if (res.status < 300 && (res.headers.get('content-type') ?? '').includes('text/html')) {
        let html = res.body;
        if (browser) {
          try {
            html = await renderHtml(browser, res, target);
          } catch (err) {
            issues.push(`render failed: ${errMessage(err)}`);
          }
        }
        const $ = cheerio.load(html);
        title = $('title').first().text().trim() || null;
        description = $('meta[name="description"]').attr('content')?.trim() || null;
        if (!title) {
          issues.push('missing <title>');
          findings.push({ source: 'CRAWLER', severity: 'LOW', title: 'Missing page title', url: item.url,
            description: `${item.url} has no <title> element.`, remediation: 'Add a unique, descriptive <title> (about 50–60 characters).' });
        }
        if (!description) {
          issues.push('missing meta description');
          findings.push({ source: 'CRAWLER', severity: 'INFO', title: 'Missing meta description', url: item.url,
            description: `${item.url} has no meta description.`, remediation: 'Add <meta name="description"> summarising the page in about 150 characters.' });
        }
        if ($('h1').length === 0) issues.push('no <h1>');
        if (res.ms > 1500) {
          issues.push(`slow response (${res.ms}ms)`);
          findings.push({ source: 'CRAWLER', severity: 'LOW', title: 'Slow page response', url: item.url,
            description: `${item.url} took ${res.ms}ms to respond.`, remediation: 'Profile the page (caching, database queries, payload size).' });
        }
        if (item.depth < cfg.maxDepth) {
          $('a[href]').each((_, el) => {
            const next = normalise($(el).attr('href')!, res.finalUrl);
            if (next && isInScope(next, target) && !queued.has(next) && queued.size < cfg.maxPages * 3) {
              queued.add(next);
              queue.push({ url: next, depth: item.depth + 1, foundOn: item.url });
            }
          });
        }
      }
    } catch (err) {
      const msg = errMessage(err);
      issues.push(`request failed: ${msg}`);
      findings.push({ source: 'CRAWLER', severity: 'MEDIUM', title: 'Request failed', url: item.url,
        description: `Could not fetch ${item.url}: ${msg}`, remediation: 'Check that the server is reachable and responds within 15 seconds.' });
    }

    crawled++;
    pageRows.push({ runId: run.id, url: item.url, status, depth: item.depth, title, description, loadMs,
      redirectChain: chain, foundOn: item.foundOn ?? null, issues });
    await progress(run.id, `Crawled ${item.url}`, crawled, Math.min(cfg.maxPages, crawled + queue.length));
    await sleep(delay);
  }
  } finally {
    await browser?.close();
  }

  await prisma.crawlPage.createMany({ data: pageRows });
  await saveFindings(run, findings);
  await audit(run.id, 'crawl', `Crawled ${crawled} pages, ${findings.length} findings`);

  const ok = pageRows.filter((p) => p.loadMs !== null);
  const summary: CrawlSummary = {
    pagesCrawled: crawled,
    brokenLinks: pageRows.filter((p) => p.status !== null && p.status >= 400).length,
    redirects: pageRows.filter((p) => p.redirectChain && (p.redirectChain as unknown[]).length > 1).length,
    missingTitle: pageRows.filter((p) => p.issues.includes('missing <title>')).length,
    missingDescription: pageRows.filter((p) => p.issues.includes('missing meta description')).length,
    avgLoadMs: ok.length ? ok.reduce((a, p) => a + (p.loadMs ?? 0), 0) / ok.length : 0,
  };
  return { status: cancelled ? 'CANCELLED' : 'COMPLETED', summary: summary as never };
}
