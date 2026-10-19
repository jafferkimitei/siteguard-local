import { statusMeaning, type StressSummary } from '@siteguard/contracts';
import type { CrawlPage, Finding, MetricPoint, Run, Target } from '@siteguard/database';

export type FullRun = Run & { target: Target; metrics: MetricPoint[]; pages: CrawlPage[]; findings: Finding[] };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');

export function runToCsv(run: FullRun): string {
  if (run.type === 'LOAD')
    return toCsv(['timestamp', 'rps', 'p50_ms', 'p95_ms', 'p99_ms', 'error_rate', 'vus'],
      run.metrics.map((m) => [m.ts.toISOString(), m.rps, m.p50.toFixed(1), m.p95.toFixed(1), m.p99.toFixed(1), m.errorRate.toFixed(4), m.vus]));
  if (run.type === 'STRESS') {
    const sum = run.summary as unknown as StressSummary | null;
    return toCsv(['bots', 'req_per_s', 'p50_ms', 'p95_ms', 'p99_ms', 'error_rate', 'requests'],
      (sum?.levels ?? []).map((l) => [l.bots, l.rps.toFixed(1), l.p50.toFixed(1), l.p95.toFixed(1), l.p99.toFixed(1), l.errorRate.toFixed(4), l.requests]));
  }
  if (run.type === 'CRAWL')
    return toCsv(['url', 'status', 'depth', 'title', 'description', 'load_ms', 'found_on', 'issues'],
      run.pages.map((p) => [p.url, p.status, p.depth, p.title, p.description, p.loadMs, p.foundOn, p.issues.join('; ')]));
  return toCsv(['severity', 'source', 'title', 'url', 'status', 'description', 'evidence', 'remediation'],
    run.findings.map((f) => [f.severity, f.source, f.title, f.url, f.status, f.description, f.evidence, f.remediation]));
}

function stressHtml(s: StressSummary): string {
  const kv = (k: string, v: unknown) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
  const head = [
    kv('Requests', s.totalRequests), kv('Error rate', `${(s.errorRate * 100).toFixed(2)}%`), kv('Peak bots', s.peakBots), kv('Peak req/s', s.peakRps.toFixed(1)),
    kv('Breaking point', s.breakingPoint ? `${s.breakingPoint.bots} bots` : 'not reached'),
    kv('Recovery', s.recovery ? (s.recovery.recovered ? `${s.recovery.secondsToBaseline}s` : 'did not recover') : '—'),
  ].join('');
  const health = s.health.map((h) => `<p class="f ${h.verdict === 'bad' ? 'HIGH' : h.verdict === 'warn' ? 'MEDIUM' : 'LOW'}"><b>${esc(h.verdict.toUpperCase())}</b> ${esc(h.text)}</p>`).join('');
  const hyp = `</div><p><b>Hypothesis:</b> ${esc(s.hypothesis)}</p>${health}${s.patterns.map((p) => `<p class="fix">${esc(p.message)}</p>`).join('')}<div class="kvs">`;
  const levels = `</div><h2>Load by interval</h2><table><tr><th>Bots</th><th>req/s</th><th>p50</th><th>p95</th><th>p99</th><th>Errors</th></tr>${s.levels.map((l) => `<tr><td>${l.bots}</td><td>${l.rps.toFixed(1)}</td><td>${Math.round(l.p50)} ms</td><td>${Math.round(l.p95)} ms</td><td>${Math.round(l.p99)} ms</td><td>${(l.errorRate * 100).toFixed(1)}%</td></tr>`).join('')}</table>`;
  const steps = `<h2>By journey step</h2><table><tr><th>Journey</th><th>Step</th><th>Requests</th><th>p95</th><th>Errors</th></tr>${s.steps.map((t) => `<tr><td>${esc(t.journey)}</td><td>${esc(t.step)}</td><td>${t.requests}</td><td>${Math.round(t.p95)} ms</td><td>${(t.errorRate * 100).toFixed(1)}%</td></tr>`).join('')}</table>`;
  const codes = `<h2>Status codes</h2><table><tr><th>Code</th><th>Count</th><th>Meaning</th><th>Usual cause</th></tr>${Object.entries(s.statusCounts).sort().map(([c, n]) => { const m = statusMeaning(c); return `<tr><td>${esc(c === '0' ? 'no response' : c)}</td><td>${n}</td><td>${esc(m.meaning)}</td><td>${esc(m.cause)}</td></tr>`; }).join('')}</table>`;
  return head + hyp + levels + steps + codes;
}

export function runToHtml(run: FullRun): string {
  const s = (run.summary ?? {}) as Record<string, any>;
  const kv = (k: string, v: unknown) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
  let summary = '';
  if (run.type === 'LOAD')
    summary = [kv('Requests', s.totalRequests), kv('Error rate', `${((s.errorRate ?? 0) * 100).toFixed(2)}%`), kv('Avg req/s', (s.avgRps ?? 0).toFixed(1)),
      kv('p50', `${(s.p50 ?? 0).toFixed(0)} ms`), kv('p95', `${(s.p95 ?? 0).toFixed(0)} ms`), kv('p99', `${(s.p99 ?? 0).toFixed(0)} ms`), kv('Max', `${(s.maxMs ?? 0).toFixed(0)} ms`)].join('');
  else if (run.type === 'STRESS') summary = stressHtml(s as StressSummary);
  else if (run.type === 'CRAWL')
    summary = [kv('Pages', s.pagesCrawled), kv('Broken', s.brokenLinks), kv('Redirects', s.redirects), kv('No title', s.missingTitle), kv('No description', s.missingDescription), kv('Avg load', `${(s.avgLoadMs ?? 0).toFixed(0)} ms`)].join('');
  else summary = [kv('Findings', s.findings), ...Object.entries(s.bySeverity ?? {}).map(([k, v]) => kv(k, v))].join('');

  const findings = run.findings.length
    ? `<h2>Findings (${run.findings.length})</h2>` +
      run.findings.map((f) => `<div class="f ${f.severity}"><b>[${f.severity}] ${esc(f.title)}</b><div class="u">${esc(f.url)}</div><p>${esc(f.description)}</p>${f.evidence ? `<pre>${esc(f.evidence)}</pre>` : ''}${f.remediation ? `<p class="fix"><b>Fix:</b> ${esc(f.remediation)}</p>` : ''}</div>`).join('')
    : '';
  const pages = run.pages.length
    ? `<h2>Pages (${run.pages.length})</h2><table><tr><th>Status</th><th>URL</th><th>Title</th><th>ms</th><th>Issues</th></tr>${run.pages.map((p) => `<tr><td>${p.status ?? '—'}</td><td>${esc(p.url)}</td><td>${esc(p.title)}</td><td>${p.loadMs ?? ''}</td><td>${esc(p.issues.join('; '))}</td></tr>`).join('')}</table>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>SiteGuard report ${esc(run.id)}</title><style>
body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}h1{margin-bottom:0}.meta{color:#666}
.kvs{display:flex;flex-wrap:wrap;gap:.75rem;margin:1rem 0}.kv{border:1px solid #ddd;border-radius:8px;padding:.5rem .9rem}.kv span{display:block;font-size:12px;color:#666}
.f{border-left:4px solid #999;background:#f7f7f7;padding:.5rem 1rem;margin:.6rem 0}.f.CRITICAL,.f.HIGH{border-color:#c0392b}.f.MEDIUM{border-color:#e67e22}.f.LOW{border-color:#f1c40f}.u{color:#666;font-size:12px}
pre{background:#eee;padding:.5rem;overflow:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;font-size:13px}.fix{color:#1e6b3a}
</style></head><body><h1>${esc(run.type)} report — ${esc(run.target.name)}</h1>
<div class="meta">${esc(run.target.baseUrl)} · ${esc(run.status)} · started ${esc(run.startedAt?.toISOString())} · run ${esc(run.id)}</div>
${run.error ? `<p><b>Note:</b> ${esc(run.error)}</p>` : ''}<div class="kvs">${summary}</div>${findings}${pages}</body></html>`;
}
