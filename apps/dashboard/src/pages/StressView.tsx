import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { statusMeaning, type HealthVerdict, type StressSummary } from '@siteguard/contracts';
import type { Metric, Run } from '../api';
import { Badge, Card, Stat, ms, pct } from '../ui';

const AXIS = { tick: { fill: '#8b95a5', fontSize: 11 } };
const TIP = { contentStyle: { background: '#161b22', border: '1px solid #262d37' } };
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
// Time on a numeric axis (not category labels) so reference lines can be placed at exact moments.
const XAXIS = { dataKey: 'x', type: 'number' as const, domain: ['dataMin', 'dataMax'] as [string, string], tickFormatter: clock, ...AXIS, minTickGap: 40 };
const TIME_TIP = { ...TIP, labelFormatter: (v: unknown) => clock(Number(v)) };
const VERDICT_KIND = { ok: 'COMPLETED', warn: 'MEDIUM', bad: 'HIGH' } as const;

const Verdict = ({ v }: { v: HealthVerdict }) => (
  <li className="flex items-start gap-2"><Badge kind={VERDICT_KIND[v.verdict]}>{v.verdict === 'ok' ? 'healthy' : v.verdict === 'warn' ? 'watch' : 'problem'}</Badge><span>{v.text}</span></li>
);

const Vital = ({ label, value, good, poor, unit }: { label: string; value: number; good: number; poor: number; unit: string }) => (
  <div className="rounded-lg border border-line px-3 py-2">
    <div className="text-xs text-muted">{label}</div>
    <div className={`text-lg font-semibold tabular-nums ${value <= good ? 'text-emerald-300' : value <= poor ? 'text-orange-200' : 'text-red-300'}`}>{unit ? Math.round(value) : value.toFixed(2)}{unit && <span className="ml-1 text-xs text-muted">{unit}</span>}</div>
  </div>
);

export default function StressView({ run, points, active }: { run: Run; points: Metric[]; active: boolean }) {
  const s = run.summary as StressSummary | null;
  const cfg = run.config as { hypothesis?: string; profile?: string };
  const chart = points.map((p) => ({ ...p, x: Date.parse(p.ts), bots: p.bots ?? p.vus, err: +(p.errorRate * 100).toFixed(2) }));
  const last = points[points.length - 1];
  const bpTime = s?.breakingPoint ? chart.find((p) => p.bots === s.breakingPoint!.bots && p.phase !== 'recovery')?.x : undefined;
  const recoveryStart = chart.find((p) => p.phase === 'recovery')?.x;
  const codes = Object.entries(s?.statusCounts ?? {}).sort();
  const failing = (s?.steps ?? []).filter((t) => t.errorRate > 0.05);

  return (
    <>
      <Card title="Hypothesis"><p>{cfg.hypothesis}</p>{s && <p className="mt-2 text-xs text-muted">{s.breakingPoint ? 'The site stopped coping at the load shown below.' : 'No breaking point was found at the load that was tested.'}</p>}</Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Bots now" value={last ? (last.bots ?? last.vus) : s?.peakBots ?? 0} sub={s ? `peak ${s.peakBots}` : last?.phase} />
        <Stat label="Req/s" value={(s?.peakRps ?? last?.rps ?? 0).toFixed(1)} sub={s ? 'peak' : 'now'} />
        <Stat label="p95" value={ms(last?.p95)} />
        <Stat label="Errors" value={pct(s?.errorRate ?? last?.errorRate)} sub={s ? `${s.failedRequests} of ${s.totalRequests}` : undefined} />
        <Stat label="Breaking point" value={s ? (s.breakingPoint ? `${s.breakingPoint.bots} bots` : 'not found') : '—'} sub={s?.breakingPoint ? `${s.breakingPoint.rps.toFixed(0)} req/s` : undefined} />
        <Stat label="Recovery" value={s?.recovery ? (s.recovery.recovered ? `${s.recovery.secondsToBaseline}s` : 'none') : '—'} sub={s?.recovery && !s.recovery.recovered ? `${pct(s.recovery.residualErrorRate)} errors left` : undefined} />
      </div>

      {s && (
        <Card title="Health">
          <ul className="space-y-2">{s.health.map((h) => <Verdict key={h.id} v={h} />)}</ul>
          {s.patterns.map((p) => <p key={p.pattern} className="mt-3 rounded-md border border-line px-3 py-2 text-sm">{p.message}</p>)}
          {s.ceilingReached && <p className="mt-3 text-sm text-orange-200">Throughput reached this target&apos;s req/s ceiling, so a plateau may reflect the configured limit rather than the server.</p>}
          {s.driftPct !== null && <p className="mt-3 text-sm">Latency drift during the soak: <b>{(s.driftPct * 100).toFixed(0)}%</b> {s.driftPct > 0.25 ? '(possible leak or growing resource)' : '(stable)'}</p>}
          {s.integrity && <p className={`mt-3 text-sm ${s.integrity.failures ? 'text-red-300' : 'text-emerald-300'}`}>Data-integrity checks: {s.integrity.checks - s.integrity.failures} of {s.integrity.checks} passed.</p>}
          {s.cacheHitRatio !== null && <p className="mt-3 text-sm">Cache hit ratio: <b>{pct(s.cacheHitRatio)}</b></p>}
          {s.wafBlocks > 0 && <p className="mt-3 text-sm text-orange-200">{s.wafBlocks} responses looked like WAF or rate-limit blocks.</p>}
        </Card>
      )}

      {s && (s.vitals || s.browser || s.resources) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {(s.vitals || s.browser) && (
            <Card title="Real-browser experience (Core Web Vitals, 75th percentile)">
              {s.vitals ? (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Vital label="TTFB" value={s.vitals.ttfb} good={800} poor={1800} unit="ms" />
                  <Vital label="FCP" value={s.vitals.fcp} good={1800} poor={3000} unit="ms" />
                  <Vital label="LCP" value={s.vitals.lcp} good={2500} poor={4000} unit="ms" />
                  <Vital label="CLS" value={s.vitals.cls} good={0.1} poor={0.25} unit="" />
                </div>
              ) : <p className="text-muted">No HTML page loads were measured.</p>}
              {s.browser && <p className="mt-3 text-xs text-muted">{s.browser.sessions} page loads · {s.browser.failedSteps} failed steps{s.browser.consoleErrors.length ? ` · ${s.browser.consoleErrors.join(' | ')}` : ''}</p>}
            </Card>
          )}
          {s.resources && (
            <Card title="Container resources (docker stats)">
              <div className="grid grid-cols-2 gap-3">
                <Stat label="CPU avg / peak" value={`${s.resources.cpuAvg.toFixed(0)}% / ${s.resources.cpuMax.toFixed(0)}%`} />
                <Stat label="Memory start to end" value={`${Math.round(s.resources.memStartMb)} to ${Math.round(s.resources.memEndMb)} MB`} sub={`peak ${Math.round(s.resources.memMaxMb)} MB`} />
              </div>
            </Card>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Bots and throughput">
          <ResponsiveContainer width="100%" height={220}><AreaChart data={chart}>
            <CartesianGrid stroke="#262d37" vertical={false} /><XAxis {...XAXIS} /><YAxis {...AXIS} width={40} />
            <Tooltip {...TIME_TIP} /><Legend />
            {bpTime !== undefined && <ReferenceLine x={bpTime} stroke="#f87171" strokeDasharray="4 3" label={{ value: 'breaking point', fill: '#f87171', fontSize: 11, position: 'insideTopLeft' }} />}
            {recoveryStart !== undefined && <ReferenceLine x={recoveryStart} stroke="#34d399" strokeDasharray="4 3" label={{ value: 'recovery', fill: '#34d399', fontSize: 11, position: 'insideTopRight' }} />}
            <Area name="req/s" dataKey="rps" stroke="#4f9cf9" fill="#4f9cf9" fillOpacity={0.2} isAnimationActive={false} />
            <Area name="bots" dataKey="bots" stroke="#a78bfa" fill="none" type="stepAfter" isAnimationActive={false} />
          </AreaChart></ResponsiveContainer>
        </Card>
        <Card title="Latency (ms)">
          <ResponsiveContainer width="100%" height={220}><LineChart data={chart}>
            <CartesianGrid stroke="#262d37" vertical={false} /><XAxis {...XAXIS} /><YAxis {...AXIS} width={44} />
            <Tooltip {...TIME_TIP} formatter={(v) => `${Number(v).toFixed(1)} ms`} /><Legend />
            {bpTime !== undefined && <ReferenceLine x={bpTime} stroke="#f87171" strokeDasharray="4 3" />}
            <Line name="p50" dataKey="p50" stroke="#34d399" dot={false} isAnimationActive={false} />
            <Line name="p95" dataKey="p95" stroke="#fbbf24" dot={false} isAnimationActive={false} />
            <Line name="p99" dataKey="p99" stroke="#f87171" dot={false} isAnimationActive={false} />
          </LineChart></ResponsiveContainer>
        </Card>
        <Card title="Error rate (%)">
          <ResponsiveContainer width="100%" height={180}><AreaChart data={chart}>
            <CartesianGrid stroke="#262d37" vertical={false} /><XAxis {...XAXIS} /><YAxis {...AXIS} width={40} domain={[0, 'auto']} />
            <Tooltip {...TIME_TIP} formatter={(v) => `${v}%`} />
            <Area name="errors" dataKey="err" stroke="#f87171" fill="#f87171" fillOpacity={0.2} isAnimationActive={false} />
          </AreaChart></ResponsiveContainer>
        </Card>
        <Card title="Status codes">
          {!s ? <p className="text-muted">Available when the run finishes.</p> : codes.length === 0 ? <p className="text-muted">No responses.</p> : (
            <table><thead><tr><th>Code</th><th>Count</th><th>What it means</th></tr></thead><tbody>
              {codes.map(([code, n]) => { const m = statusMeaning(code); const bad = code === '0' || Number(code) >= 400; return (
                <tr key={code}><td className="font-mono">{code === '0' ? 'no response' : code}</td><td>{n}</td>
                  <td className={bad ? '' : 'text-muted'}>{bad ? <><b>{m.meaning}.</b> <span className="text-muted">{m.cause}</span></> : m.meaning}</td></tr>); })}
            </tbody></table>
          )}
          {s && Object.keys(s.errorKinds).length > 0 && <p className="mt-3 text-sm text-red-300">Network-level failures: {Object.entries(s.errorKinds).map(([k, n]) => `${k} ×${n}`).join(', ')}</p>}
        </Card>
      </div>

      {s && <>
        <Card title="Load by interval">
          <table><thead><tr><th>Bots</th><th>req/s</th><th>p50</th><th>p95</th><th>p99</th><th>Errors</th><th>Requests</th></tr></thead><tbody>
            {s.levels.map((l, i) => (
              <tr key={i} className={s.breakingPoint?.levelIndex === i || s.breakingPoint?.bots === l.bots ? 'bg-red-500/10' : ''}>
                <td className="tabular-nums">{l.bots}</td><td className="tabular-nums">{l.rps.toFixed(1)}</td><td>{ms(l.p50)}</td><td>{ms(l.p95)}</td><td>{ms(l.p99)}</td><td>{pct(l.errorRate)}</td><td className="tabular-nums">{l.requests}</td></tr>))}
          </tbody></table>
        </Card>
        <Card title="By journey step">
          {failing.length > 0 && <p className="mb-3 text-sm text-red-300">Failing steps: {failing.map((t) => t.step).join(', ')}. If other steps are healthy, the problem is likely something only these steps depend on.</p>}
          <table><thead><tr><th>Journey</th><th>Step</th><th>Requests</th><th>p50</th><th>p95</th><th>Errors</th></tr></thead><tbody>
            {s.steps.map((t) => (<tr key={`${t.journey}/${t.step}`}><td className="text-muted">{t.journey}</td><td>{t.step}</td><td className="tabular-nums">{t.requests}</td><td>{ms(t.p50)}</td><td>{ms(t.p95)}</td>
              <td className={t.errorRate > 0.05 ? 'text-red-300' : t.errorRate > 0.01 ? 'text-orange-200' : ''}>{pct(t.errorRate)}</td></tr>))}
          </tbody></table>
        </Card>
        <Card title="Export">
          <a className="text-accent underline" href={`/api/runs/${run.id}/k6-script`}>Download the k6 script</a>
          <span className="ml-2 text-xs text-muted">(reads its journeys and schedule from environment variables supplied by SiteGuard)</span>
        </Card>
      </>}
      {!s && active && <p className="text-sm text-muted">Results, health verdicts and the breaking point appear when the run finishes.</p>}
    </>
  );
}
