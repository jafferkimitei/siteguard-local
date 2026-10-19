import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { reportsDir, type Target } from '@siteguard/database';
import { assertDestinationAllowed, percentile } from '@siteguard/safety';
import { extractInto, renderTemplate, type DataRow, type JourneyInput, type JourneyStep, type StressSummary } from '@siteguard/contracts';
import { errMessage, sleep } from './common';
import { USER_AGENT } from './http';
import { launchBrowser } from './render';

/** Browser bots may use at most this share of the target's req/s ceiling (each page pulls ~25 subresources). */
const BROWSER_SHARE = 0.2;
const REQUESTS_PER_PAGE = 25;

interface Vitals { ttfb: number; fcp: number; lcp: number; cls: number }

/** Core Web Vitals for the page that just loaded (buffered entries, short settle). */
async function readVitals(page: Page): Promise<Vitals> {
  return page.evaluate(
    () =>
      new Promise<{ ttfb: number; fcp: number; lcp: number; cls: number }>((resolve) => {
        const out = { ttfb: 0, fcp: 0, lcp: 0, cls: 0 };
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        out.ttfb = nav ? nav.responseStart : 0;
        new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (e.name === 'first-contentful-paint') out.fcp = e.startTime; })).observe({ type: 'paint', buffered: true });
        new PerformanceObserver((l) => l.getEntries().forEach((e) => { out.lcp = e.startTime; })).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => l.getEntries().forEach((e) => { const ls = e as unknown as { hadRecentInput: boolean; value: number }; if (!ls.hadRecentInput) out.cls += ls.value; })).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve(out), 600);
      }),
  );
}

export interface BrowserBotResult {
  vitals: StressSummary['vitals'];
  browser: { sessions: number; failedSteps: number; consoleErrors: string[]; screenshot: string | null };
}

/**
 * A few real Chromium bots that run the journey alongside the protocol bots, so you can see what a
 * user's browser experiences while the backend is under load. Hard-capped because each bot is a full browser.
 */
export function startBrowserBots(o: {
  runId: string;
  target: Target;
  journeys: (JourneyInput & { weight: number })[];
  count: number;
  maxRps: number;
  secrets: Record<string, string>;
  rows: Record<string, unknown>[];
}) {
  let stopped = false;
  const vitals: Vitals[] = [];
  let failedSteps = 0;
  const consoleErrors: string[] = [];
  let screenshot: string | null = null;
  let browser: Browser | null = null;
  const origin = new URL(o.target.baseUrl).origin;
  const pageGapMs = Math.ceil((o.count * REQUESTS_PER_PAGE * 1000) / Math.max(1, o.maxRps * BROWSER_SHARE));
  const normal = o.journeys.map((j) => ({ ...j, steps: j.steps.filter((s) => s.kind === 'normal') })).filter((j) => j.steps.length);

  async function newContext(b: Browser): Promise<BrowserContext> {
    const ctx = await b.newContext({ userAgent: USER_AGENT, serviceWorkers: 'block' });
    const verdicts = new Map<string, Promise<boolean>>();
    const allowed = (url: string) => {
      const key = new URL(url).origin;
      let v = verdicts.get(key);
      if (!v) verdicts.set(key, (v = assertDestinationAllowed(url, o.target).then(() => true, () => false)));
      return v;
    };
    await ctx.route('**/*', async (route) => (/^https?:/i.test(route.request().url()) && (await allowed(route.request().url())) ? route.continue() : route.abort()));
    return ctx;
  }

  async function runStep(ctx: BrowserContext, page: Page, st: JourneyStep, vars: Record<string, string>, row: DataRow): Promise<boolean> {
    const rc = { vars, row, secrets: o.secrets };
    const url = origin + renderTemplate(st.path, rc, true);
    let headersOut: Record<string, string> = {};
    let status = 0;
    let text = '';
    const isNav = st.method === 'GET' && st.bodyType === 'none';
    if (isNav) {
      const res = await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
      status = res?.status() ?? 0;
      headersOut = res?.headers() ?? {};
      text = (await res?.text().catch(() => '')) ?? '';
      if (status > 0 && status < 400 && /text\/html/.test(res?.headers()['content-type'] ?? '')) vitals.push(await readVitals(page));
    } else {
      const headers = Object.fromEntries(Object.entries(st.headers).map(([k, v]) => [k, renderTemplate(v, rc, false)]));
      const body = renderTemplate(st.body, rc, st.bodyType === 'form');
      if (st.bodyType === 'json') headers['Content-Type'] ??= 'application/json';
      if (st.bodyType === 'form') headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
      const res = await ctx.request.fetch(url, { method: st.method, headers, data: st.bodyType === 'none' ? undefined : body, maxRedirects: 0, timeout: 20_000 });
      status = res.status();
      headersOut = res.headers();
      text = await res.text().catch(() => '');
    }
    extractInto(st, { status, text, headers: headersOut }, vars);
    return status > 0 && status < 400;
  }

  async function bot(i: number) {
    const b = browser!;
    const ctx = await newContext(b);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && consoleErrors.length < 5) consoleErrors.push(m.text().slice(0, 200)); });
    let iter = 0;
    while (!stopped && normal.length) {
      const total = normal.reduce((a, j) => a + j.weight, 0);
      let r = Math.random() * total;
      const j = normal.find((x) => (r -= x.weight) <= 0) ?? normal[normal.length - 1]!;
      const row = o.rows.length ? o.rows[(i + iter++) % o.rows.length]! : null;
      const vars: Record<string, string> = {};
      for (const st of j.steps) {
        if (stopped) break;
        let ok = false;
        try { ok = await runStep(ctx, page, st, vars, row); } catch (err) { if (consoleErrors.length < 5) consoleErrors.push(errMessage(err).slice(0, 200)); }
        if (!ok) {
          failedSteps++;
          if (!screenshot) {
            try {
              mkdirSync(reportsDir, { recursive: true });
              const file = join(reportsDir, `stress-${o.runId}-browser-failure.png`);
              await page.screenshot({ path: file });
              screenshot = file;
            } catch { /* page may already be closed */ }
          }
          break;
        }
        await sleep(Math.max(st.thinkMs, pageGapMs));
      }
      await sleep(Math.max(1000, pageGapMs));
    }
    await ctx.close().catch(() => undefined);
  }

  const done = (async () => {
    try {
      browser = await launchBrowser();
      await Promise.all(Array.from({ length: o.count }, (_, i) => bot(i)));
    } catch (err) {
      if (consoleErrors.length < 5) consoleErrors.push(`browser bots could not start: ${errMessage(err).slice(0, 200)}`);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  })();

  return {
    async stop(): Promise<BrowserBotResult> {
      stopped = true;
      await done;
      const p75 = (f: (v: Vitals) => number) => percentile(vitals.map(f).sort((a, b) => a - b), 75);
      return {
        vitals: vitals.length ? { sessions: vitals.length, ttfb: p75((v) => v.ttfb), fcp: p75((v) => v.fcp), lcp: p75((v) => v.lcp), cls: p75((v) => v.cls) } : null,
        browser: { sessions: vitals.length, failedSteps, consoleErrors, screenshot },
      };
    },
  };
}
