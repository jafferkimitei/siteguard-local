import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Run } from '../api';
import { Badge, Btn, Card, ErrorBox, TYPE_LABEL, ms, pct, runResult, when } from '../ui';

export default function Reports() {
  const nav = useNavigate();
  const [runs, setRuns] = useState<Run[]>([]);
  const [type, setType] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => { api<Run[]>(`/runs?limit=200${type ? `&type=${type}` : ''}`).then(setRuns); }, [type]);
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Reports &amp; history</h1>
      <div className="flex items-center gap-3">
        <select className="!w-44" value={type} onChange={(e) => { setType(e.target.value); setSel([]); }}><option value="">All types</option><option value="LOAD">Load tests</option><option value="CRAWL">Crawls</option><option value="SECURITY">Security scans</option></select>
        <Btn disabled={sel.length !== 2} onClick={() => nav(`/reports/compare?a=${sel[0]}&b=${sel[1]}`)}>Compare selected ({sel.length}/2)</Btn>
        <span className="text-xs text-muted">Pick two runs of the same type — the older one first is the baseline.</span>
      </div>
      <Card>
        {runs.length === 0 ? <p className="text-muted">No runs yet.</p> : (
          <table><thead><tr><th /><th>When</th><th>Type</th><th>Target</th><th>Status</th><th>Result</th></tr></thead><tbody>
            {runs.map((r) => (<tr key={r.id}>
              <td><input type="checkbox" checked={sel.includes(r.id)} onChange={() => toggle(r.id)} /></td>
              <td><Link className="text-accent" to={`/runs/${r.id}`}>{when(r.createdAt)}</Link></td><td>{TYPE_LABEL[r.type]}</td><td>{r.target?.name}</td><td><Badge kind={r.status} /></td><td className="text-muted">{runResult(r)}</td></tr>))}
          </tbody></table>
        )}
      </Card>
    </div>
  );
}

const Delta = ({ a, b, fmt, lowerIsBetter = true }: { a: number; b: number; fmt: (n: number) => string; lowerIsBetter?: boolean }) => {
  const d = b - a;
  const rel = a ? (d / a) * 100 : 0;
  const good = d === 0 ? null : lowerIsBetter ? d < 0 : d > 0;
  return <span className={good === null ? 'text-muted' : good ? 'text-emerald-300' : 'text-red-300'}>{d > 0 ? '+' : ''}{fmt(d)}{a ? ` (${rel > 0 ? '+' : ''}${rel.toFixed(0)}%)` : ''}</span>;
};

export function Compare() {
  const [q] = useSearchParams();
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api(`/compare?a=${q.get('a')}&b=${q.get('b')}`).then(setD, (e) => setError(e.message)); }, [q]);
  if (error) return <ErrorBox error={error} />;
  if (!d) return <p className="text-muted">Loading…</p>;
  const { a, b, findings } = d;
  const rows: [string, string, (n: number) => string, boolean?][] = [
    ['p50', 'p50', ms], ['p95', 'p95', ms], ['p99', 'p99', ms], ['avgMs', 'Average', ms], ['errorRate', 'Error rate', pct],
    ['avgRps', 'Avg req/s', (n) => n.toFixed(1), false], ['totalRequests', 'Requests', (n) => String(Math.round(n)), false],
  ];
  return (
    <div className="space-y-6">
      <div className="text-xs text-muted"><Link to="/reports" className="hover:underline">Reports</Link> / Compare</div>
      <h1 className="text-xl font-semibold">Comparing two {a.type.toLowerCase()} runs</h1>
      {d.warning && <div className="rounded-md border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-sm text-orange-200">{d.warning}</div>}
      {d.configDiff?.length === 1 && <p className="text-sm text-emerald-300">One setting differs between these runs: <b>{d.configDiff[0]}</b>.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {[['Baseline (A)', a], ['Candidate (B)', b]].map(([label, r]: any) => (
          <Card key={r.id} title={label}><Link to={`/runs/${r.id}`} className="text-accent">{when(r.createdAt)}</Link> · {r.target}</Card>))}
      </div>
      {a.type === 'LOAD' && a.summary && b.summary && (
        <Card title="Performance"><table><thead><tr><th>Metric</th><th>A</th><th>B</th><th>Change</th></tr></thead><tbody>
          {rows.map(([k, label, fmt, lower = true]) => (<tr key={k}><td>{label}</td><td>{fmt(a.summary[k])}</td><td>{fmt(b.summary[k])}</td><td><Delta a={a.summary[k]} b={b.summary[k]} fmt={fmt} lowerIsBetter={lower} /></td></tr>))}
        </tbody></table><p className="mt-3 text-xs text-muted">Only comparable when both runs used the same paths and request rate. A: {a.config.rps} req/s · B: {b.config.rps} req/s.</p></Card>
      )}
      {a.type === 'STRESS' && a.summary && b.summary && (
        <Card title="Stress results"><table><thead><tr><th>Metric</th><th>A</th><th>B</th></tr></thead><tbody>
          <tr><td>Breaking point</td><td>{a.summary.breakingPoint ? `${a.summary.breakingPoint.bots} bots` : 'not found'}</td><td>{b.summary.breakingPoint ? `${b.summary.breakingPoint.bots} bots` : 'not found'}</td></tr>
          <tr><td>Peak req/s</td><td>{a.summary.peakRps.toFixed(1)}</td><td>{b.summary.peakRps.toFixed(1)}</td></tr>
          <tr><td>Error rate</td><td>{pct(a.summary.errorRate)}</td><td>{pct(b.summary.errorRate)}</td></tr>
          <tr><td>Recovery</td><td>{a.summary.recovery ? (a.summary.recovery.recovered ? `${a.summary.recovery.secondsToBaseline}s` : 'none') : '—'}</td><td>{b.summary.recovery ? (b.summary.recovery.recovered ? `${b.summary.recovery.secondsToBaseline}s` : 'none') : '—'}</td></tr>
        </tbody></table></Card>
      )}
      {a.type !== 'LOAD' && <>
        <div className="grid grid-cols-3 gap-3 text-center">
          <Card><div className="text-2xl font-semibold text-red-300">{findings.newInB.length}</div><div className="text-xs text-muted">new in B</div></Card>
          <Card><div className="text-2xl font-semibold text-emerald-300">{findings.resolvedInB.length}</div><div className="text-xs text-muted">resolved in B</div></Card>
          <Card><div className="text-2xl font-semibold">{findings.unchanged}</div><div className="text-xs text-muted">unchanged</div></Card>
        </div>
        {([['New in B', findings.newInB], ['Resolved in B', findings.resolvedInB]] as const).map(([title, list]) => (
          <Card key={title} title={`${title} (${list.length})`}>{list.length === 0 ? <p className="text-muted">None.</p> :
            <ul className="space-y-2">{list.map((f: any) => <li key={f.id} className="flex gap-2"><Badge kind={f.severity} /><span>{f.title}<span className="block font-mono text-xs text-muted">{f.url}</span></span></li>)}</ul>}</Card>))}
      </>}
    </div>
  );
}
