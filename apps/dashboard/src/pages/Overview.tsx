import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api';
import { Badge, Card, Stat, TYPE_LABEL, runResult, when } from '../ui';

export default function Overview() {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api('/overview').then(setD); }, []);
  if (!d) return <p className="text-muted">Loading…</p>;
  const open = d.openFindings as Record<string, number>;
  const trend = d.loadTrend.map((r: any, i: number) => ({ n: i + 1, label: new Date(r.createdAt).toLocaleDateString(), p95: r.p95, rps: r.avgRps, err: r.errorRate * 100 }));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Overview</h1>
      {d.targets === 0 && (
        <Card><p>No targets yet. <Link className="text-accent underline" to="/targets">Register your first website</Link> — your local dev server works too.</p></Card>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Targets" value={d.targets} />
        <Stat label="Total runs" value={d.runs} />
        <Stat label="Open critical/high" value={(open.CRITICAL ?? 0) + (open.HIGH ?? 0)} />
        <Stat label="Open medium" value={open.MEDIUM ?? 0} />
        <Stat label="Open low/info" value={(open.LOW ?? 0) + (open.INFO ?? 0)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="p95 latency across recent load tests">
          {trend.length < 2 ? <p className="text-muted">Run at least two load tests to see a trend.</p> : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trend}>
                <CartesianGrid stroke="#262d37" vertical={false} />
                <XAxis dataKey="n" tick={{ fill: '#8b95a5', fontSize: 11 }} />
                <YAxis tick={{ fill: '#8b95a5', fontSize: 11 }} unit="ms" width={50} />
                <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #262d37' }} formatter={(v) => `${Number(v).toFixed(1)} ms`} />
                <Line dataKey="p95" stroke="#4f9cf9" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Recent open findings" action={<Link to="/findings" className="text-xs text-accent">All findings</Link>}>
          {d.recentFindings.length === 0 ? <p className="text-muted">No open findings.</p> : (
            <ul className="space-y-2">
              {d.recentFindings.map((f: any) => (
                <li key={f.id} className="flex items-start gap-2"><Badge kind={f.severity} /><span><Link to={`/runs/${f.runId}`} className="hover:underline">{f.title}</Link> <span className="text-xs text-muted">{f.target.name}</span></span></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Recent runs">
        {d.recentRuns.length === 0 ? <p className="text-muted">Nothing has run yet.</p> : (
          <table>
            <thead><tr><th>Type</th><th>Target</th><th>Status</th><th>Result</th><th>When</th></tr></thead>
            <tbody>
              {d.recentRuns.map((r: any) => (
                <tr key={r.id}>
                  <td><Link className="text-accent" to={`/runs/${r.id}`}>{TYPE_LABEL[r.type as keyof typeof TYPE_LABEL]}</Link></td>
                  <td>{r.target.name}</td><td><Badge kind={r.status} /></td>
                  <td className="text-muted">{runResult(r)}</td>
                  <td className="text-muted">{when(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
