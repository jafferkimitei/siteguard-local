import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Finding, type Target } from '../api';
import { Badge, Card } from '../ui';

export default function Findings() {
  const [rows, setRows] = useState<Finding[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState('');
  const [status, setStatus] = useState('OPEN');
  const load = useCallback(() => {
    const q = new URLSearchParams(); if (targetId) q.set('targetId', targetId); if (status) q.set('status', status);
    api<Finding[]>(`/findings?${q}`).then(setRows);
  }, [targetId, status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api<Target[]>('/targets').then(setTargets); }, []);
  const update = async (f: Finding, s: string) => { await api(`/findings/${f.id}`, { method: 'PATCH', body: JSON.stringify({ status: s }) }); load(); };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Findings</h1>
      <div className="flex gap-3">
        <select className="!w-56" value={targetId} onChange={(e) => setTargetId(e.target.value)}><option value="">All targets</option>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select className="!w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option><option>OPEN</option><option>FIXED</option><option>IGNORED</option></select>
      </div>
      <Card>
        {rows.length === 0 ? <p className="text-muted">No findings match.</p> : (
          <table><thead><tr><th>Severity</th><th>Finding</th><th>Target</th><th>Status</th></tr></thead><tbody>
            {rows.map((f) => (<tr key={f.id}><td><Badge kind={f.severity} /></td>
              <td><Link to={`/runs/${f.runId}`} className="font-medium hover:underline">{f.title}</Link><div className="font-mono text-xs text-muted">{f.url}</div>{f.remediation && <div className="mt-1 text-xs text-emerald-300">Fix: {f.remediation}</div>}</td>
              <td>{f.target?.name}</td>
              <td><select className="!w-auto" value={f.status} onChange={(e) => update(f, e.target.value)}><option>OPEN</option><option>FIXED</option><option>IGNORED</option></select></td></tr>))}
          </tbody></table>
        )}
      </Card>
    </div>
  );
}
