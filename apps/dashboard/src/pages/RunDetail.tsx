import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type Finding, type Metric, type Run } from '../api';
import { Badge, Btn, Card, ErrorBox, Stat, TYPE_LABEL, ms, pct, when } from '../ui';
import StressView from './StressView';

const AXIS = { tick: { fill: '#8b95a5', fontSize: 11 } };
const TIP = { contentStyle: { background: '#161b22', border: '1px solid #262d37' } };
const clock = (ts: string) => new Date(ts).toLocaleTimeString([], { hour12: false });

type Full = Run & { target: { name: string; baseUrl: string }; metrics: Metric[]; pages: any[]; findings: Finding[] };

export default function RunDetail() {
  const { id } = useParams();
  const [run, setRun] = useState<Full | null>(null);
  const [points, setPoints] = useState<Metric[]>([]);
  const [progress, setProgress] = useState<string>('');
  const [audit, setAudit] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<Full>(`/runs/${id}`);
    setRun(r);
    setPoints((cur) => (r.metrics.length >= cur.length ? r.metrics : cur));
  }, [id]);

  useEffect(() => { refresh().catch((e) => setError(e.message)); }, [refresh]);

  const active = run?.status === 'QUEUED' || run?.status === 'RUNNING';
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!active) return;
    const es = new EventSource(`/api/runs/${id}/stream`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.kind === 'metric') setPoints((p) => (p.some((x) => x.ts === ev.point.ts) ? p : [...p, ev.point]));
      else if (ev.kind === 'progress') setProgress(ev.done ? `${ev.message} (${ev.done}/${ev.total})` : ev.message);
      else if (ev.kind === 'status') refreshRef.current();
      else if (ev.kind === 'finding') refreshRef.current();
    };
    // Safety net in case an event is missed (e.g. the run finished before we connected).
    const poll = setInterval(() => refreshRef.current(), 4000);
    return () => { es.close(); clearInterval(poll); };
  }, [active, id]);

  if (error) return <ErrorBox error={error} />;
  if (!run) return <p className="text-muted">Loading…</p>;

  const cancel = async () => { try { await api(`/runs/${id}/cancel`, { method: 'POST' }); refresh(); } catch (e) { setError((e as Error).message); } };
  const s = run.summary;
  const chart = points.map((p) => ({ ...p, t: clock(p.ts), err: +(p.errorRate * 100).toFixed(2) }));
  const last = points[points.length - 1];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs text-muted"><Link to="/reports" className="hover:underline">Reports</Link> / {TYPE_LABEL[run.type]}</div>
          <h1 className="flex items-center gap-3 text-xl font-semibold">{run.target.name} <Badge kind={run.status} /></h1>
          <div className="text-xs text-muted">{run.target.baseUrl} · started {when(run.startedAt ?? run.createdAt)}</div>
        </div>
        <div className="flex gap-2">
          {active && <Btn variant="danger" onClick={cancel}>Stop now</Btn>}
          {!active && (['json', 'csv', 'html'] as const).map((f) => <a key={f} href={`/api/runs/${run.id}/export?format=${f}`}><Btn variant="ghost">Export {f.toUpperCase()}</Btn></a>)}
        </div>
      </div>

      {run.error && <div className={`rounded-md border px-3 py-2 text-sm ${run.status === 'ABORTED' ? 'border-orange-500/40 bg-orange-500/10 text-orange-200' : 'border-red-500/40 bg-red-500/10 text-red-200'}`}>
        {run.status === 'ABORTED' ? 'Stopped automatically: ' : ''}{run.error}</div>}
      {active && <div className="text-sm text-muted">{run.status === 'QUEUED' ? 'Waiting for the worker…' : progress || 'Running…'}</div>}

      {run.type === 'LOAD' && <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <Stat label={s ? 'Requests' : 'Requests (so far)'} value={s?.totalRequests ?? points.reduce((a, p) => a + p.requests, 0)} />
          <Stat label={s ? 'Avg req/s' : 'Req/s now'} value={(s?.avgRps ?? last?.rps ?? 0).toFixed(1)} sub={s ? `peak ${s.peakRps}` : undefined} />
          <Stat label="p50" value={ms(s?.p50 ?? last?.p50)} />
          <Stat label="p95" value={ms(s?.p95 ?? last?.p95)} />
          <Stat label="p99" value={ms(s?.p99 ?? last?.p99)} />
          <Stat label="Error rate" value={pct(s?.errorRate ?? last?.errorRate)} sub={s ? `${s.failedRequests} failed` : undefined} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Throughput (req/s) and virtual users">
            <ResponsiveContainer width="100%" height={220}><AreaChart data={chart}>
              <CartesianGrid stroke="#262d37" vertical={false} /><XAxis dataKey="t" {...AXIS} minTickGap={40} /><YAxis {...AXIS} width={40} />
              <Tooltip {...TIP} /><Legend />
              <Area name="req/s" dataKey="rps" stroke="#4f9cf9" fill="#4f9cf9" fillOpacity={0.2} isAnimationActive={false} />
              <Area name="VUs" dataKey="vus" stroke="#a78bfa" fill="none" isAnimationActive={false} />
            </AreaChart></ResponsiveContainer>
          </Card>
          <Card title="Latency (ms)">
            <ResponsiveContainer width="100%" height={220}><LineChart data={chart}>
              <CartesianGrid stroke="#262d37" vertical={false} /><XAxis dataKey="t" {...AXIS} minTickGap={40} /><YAxis {...AXIS} width={44} />
              <Tooltip {...TIP} formatter={(v) => `${Number(v).toFixed(1)} ms`} /><Legend />
              <Line name="p50" dataKey="p50" stroke="#34d399" dot={false} isAnimationActive={false} />
              <Line name="p95" dataKey="p95" stroke="#fbbf24" dot={false} isAnimationActive={false} />
              <Line name="p99" dataKey="p99" stroke="#f87171" dot={false} isAnimationActive={false} />
            </LineChart></ResponsiveContainer>
          </Card>
          <Card title="Error rate (%)">
            <ResponsiveContainer width="100%" height={180}><AreaChart data={chart}>
              <CartesianGrid stroke="#262d37" vertical={false} /><XAxis dataKey="t" {...AXIS} minTickGap={40} /><YAxis {...AXIS} width={40} domain={[0, 'auto']} />
              <Tooltip {...TIP} formatter={(v) => `${v}%`} />
              <Area name="errors" dataKey="err" stroke="#f87171" fill="#f87171" fillOpacity={0.2} isAnimationActive={false} />
            </AreaChart></ResponsiveContainer>
          </Card>
          <Card title="Responses by status">
            {s ? <table><tbody>{Object.entries(s.statusCounts as Record<string, number>).sort().map(([code, n]) => (
              <tr key={code}><td className="w-24 font-mono">{code === '0' ? 'network error' : code}</td><td>{n}</td><td className="text-muted">{pct(n / s.totalRequests)}</td></tr>))}</tbody></table>
              : <p className="text-muted">Available when the run finishes.</p>}
          </Card>
        </div>
        <Card title="Configuration"><pre className="overflow-auto font-mono text-xs text-muted">{JSON.stringify(run.config, null, 2)}</pre></Card>
      </>}

      {run.type === 'STRESS' && <StressView run={run} points={points} active={!!active} />}

      {run.type === 'CRAWL' && <>
        {s && <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <Stat label="Pages" value={s.pagesCrawled} /><Stat label="Broken" value={s.brokenLinks} /><Stat label="Redirects" value={s.redirects} />
          <Stat label="No title" value={s.missingTitle} /><Stat label="No description" value={s.missingDescription} /><Stat label="Avg load" value={ms(s.avgLoadMs)} />
        </div>}
        <Card title={`Pages (${run.pages.length})`}>
          {run.pages.length === 0 ? <p className="text-muted">{active ? 'Pages appear once the crawl finishes.' : 'No pages.'}</p> : (
            <table><thead><tr><th>Status</th><th>URL</th><th>Title</th><th>Time</th><th>Issues</th></tr></thead><tbody>
              {run.pages.map((p) => (<tr key={p.id}>
                <td><Badge kind={p.status >= 400 || !p.status ? 'HIGH' : p.status >= 300 ? 'LOW' : 'COMPLETED'}>{p.status ?? 'ERR'}</Badge></td>
                <td className="font-mono text-xs">{p.url}{p.foundOn && <div className="text-muted">from {p.foundOn}</div>}</td><td>{p.title ?? <span className="text-muted">—</span>}</td>
                <td className="tabular-nums">{p.loadMs ? ms(p.loadMs) : '—'}</td><td className="text-xs text-orange-200">{p.issues.join(', ')}</td></tr>))}
            </tbody></table>
          )}
        </Card>
      </>}

      {run.type !== 'LOAD' && <FindingList findings={run.findings} onChange={refresh} active={!!active} />}

      <Card title="Audit log" action={<Btn variant="ghost" onClick={async () => setAudit(audit ? null : await api(`/runs/${id}/audit`))}>{audit ? 'Hide' : 'Show'}</Btn>}>
        {audit ? <ul className="space-y-1 font-mono text-xs">{audit.map((a) => <li key={a.id}><span className="text-muted">{new Date(a.createdAt).toLocaleTimeString()}</span> [{a.kind}] {a.message}</li>)}</ul> : <p className="text-muted">Who started what, when, and why it stopped.</p>}
      </Card>
    </div>
  );
}

export function FindingList({ findings, onChange, active }: { findings: Finding[]; onChange: () => void; active?: boolean }) {
  const setStatus = async (f: Finding, status: string) => { await api(`/findings/${f.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); onChange(); };
  return (
    <Card title={`Findings (${findings.length})`}>
      {findings.length === 0 ? <p className="text-muted">{active ? 'No findings yet…' : 'Nothing found.'}</p> : (
        <ul className="space-y-3">{findings.map((f) => (
          <li key={f.id} className="rounded-md border border-line p-3">
            <div className="flex flex-wrap items-center gap-2"><Badge kind={f.severity} /><span className="font-medium">{f.title}</span><span className="text-xs text-muted">{f.source}</span>
              <select className="ml-auto !w-auto" value={f.status} onChange={(e) => setStatus(f, e.target.value)}><option value="OPEN">Open</option><option value="FIXED">Fixed</option><option value="IGNORED">Ignored</option></select></div>
            {f.url && <div className="mt-1 font-mono text-xs text-muted">{f.url}</div>}
            <p className="mt-2">{f.description}</p>
            {f.evidence && <pre className="mt-2 overflow-auto rounded bg-black/30 p-2 font-mono text-xs">{f.evidence}</pre>}
            {f.remediation && <p className="mt-2 text-emerald-300"><b>Fix:</b> {f.remediation}</p>}
          </li>))}</ul>
      )}
    </Card>
  );
}
