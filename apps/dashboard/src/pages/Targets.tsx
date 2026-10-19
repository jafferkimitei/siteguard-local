import { useEffect, useState } from 'react';
import { api, type Target } from '../api';
import { Btn, Card, ErrorBox, Field } from '../ui';

const blank = { name: '', baseUrl: '', extraHosts: '', allowPrivateNetwork: false, activeScanAuthorized: false, maxRps: 5, maxDurationSec: 120, maxRequests: 5000 };

export default function Targets() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<Target[]>('/targets').then(setTargets);
  useEffect(() => { load(); }, []);
  const set = (k: keyof typeof blank, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/targets', { method: 'POST', body: JSON.stringify({ ...form, extraHosts: form.extraHosts.split(/[\s,]+/).filter(Boolean) }) });
      setForm(blank);
      load();
    } catch (err) { setError((err as Error).message); }
  };
  const remove = async (t: Target) => {
    if (confirm(`Delete "${t.name}" and all of its runs and findings?`)) { await api(`/targets/${t.id}`, { method: 'DELETE' }); load(); }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Targets</h1>
      <p className="max-w-2xl text-muted">Only register sites you own or are authorised to test. Every test is checked against the target's host allow-list and its rate, duration and request ceilings — on the server, not just in this form.</p>
      <Card title="Register a target">
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
          <Field label="Name"><input required value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="My site (staging)" /></Field>
          <Field label="Base URL"><input required value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="http://localhost:4000" /></Field>
          <Field label="Extra allowed hosts" hint="Comma-separated. The crawler may follow links to these hosts as well."><input value={form.extraHosts} onChange={(e) => set('extraHosts', e.target.value)} placeholder="cdn.example.com" /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Max req/s"><input type="number" min={1} value={form.maxRps} onChange={(e) => set('maxRps', +e.target.value)} /></Field>
            <Field label="Max seconds"><input type="number" min={5} value={form.maxDurationSec} onChange={(e) => set('maxDurationSec', +e.target.value)} /></Field>
            <Field label="Request budget"><input type="number" min={10} value={form.maxRequests} onChange={(e) => set('maxRequests', +e.target.value)} /></Field>
          </div>
          <label className="flex items-start gap-2"><input type="checkbox" checked={form.allowPrivateNetwork} onChange={(e) => set('allowPrivateNetwork', e.target.checked)} />
            <span>This is a local / private-network site (localhost, 192.168.x.x…)<span className="block text-xs text-muted">Private addresses are blocked by default. Cloud metadata addresses stay blocked regardless.</span></span></label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={form.activeScanAuthorized} onChange={(e) => set('activeScanAuthorized', e.target.checked)} />
            <span>I own this site and authorise active (intrusive) security scans<span className="block text-xs text-muted">Required before an OWASP ZAP active scan can be started.</span></span></label>
          <div className="md:col-span-2 space-y-3"><ErrorBox error={error} /><Btn type="submit">Add target</Btn></div>
        </form>
      </Card>
      <Card title={`Registered targets (${targets.length})`}>
        {targets.length === 0 ? <p className="text-muted">None yet. Tip: start the bundled practice site at http://localhost:4000 (ticking "local / private network").</p> : (
          <table>
            <thead><tr><th>Name</th><th>URL</th><th>Ceilings</th><th>Flags</th><th /></tr></thead>
            <tbody>{targets.map((t) => (
              <tr key={t.id}>
                <td className="font-medium">{t.name}</td><td className="font-mono text-xs">{t.baseUrl}</td>
                <td className="text-muted">{t.maxRps} req/s · {t.maxDurationSec}s · {t.maxRequests} req</td>
                <td className="text-xs text-muted">{[t.allowPrivateNetwork && 'private net', t.activeScanAuthorized && 'active scans OK'].filter(Boolean).join(', ') || '—'}</td>
                <td className="text-right"><Btn variant="ghost" onClick={() => remove(t)}>Delete</Btn></td>
              </tr>))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
