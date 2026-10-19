import { useEffect, useState } from 'react';
import { api, type Target } from '../api';
import { Btn, Card, ErrorBox, Field } from '../ui';

const blank = { name: '', baseUrl: '', extraHosts: '', allowPrivateNetwork: false, activeScanAuthorized: false, maxRps: 5, maxDurationSec: 120, maxRequests: 5000,
  stressAuthorized: false, stressMaxBots: 50, stressMaxRps: 100, stressMaxDurationSec: 600, stressMaxRequests: 100000, containerName: '' };

export default function Targets() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<Target[]>('/targets').then(setTargets);
  useEffect(() => { load(); }, []);
  const set = (k: keyof typeof blank, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(editingId ? `/targets/${editingId}` : '/targets', { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify({ ...form, containerName: form.containerName.trim() || null, extraHosts: form.extraHosts.split(/[\s,]+/).filter(Boolean) }) });
      setForm(blank);
      setEditingId(null);
      load();
    } catch (err) { setError((err as Error).message); }
  };
  const edit = (t: Target) => {
    setEditingId(t.id);
    setForm({ ...blank, ...t, extraHosts: t.extraHosts.join(', '), containerName: t.containerName ?? '' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const remove = async (t: Target) => {
    if (confirm(`Delete "${t.name}" and all of its runs and findings?`)) { await api(`/targets/${t.id}`, { method: 'DELETE' }); load(); }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Targets</h1>
      <p className="max-w-2xl text-muted">Only register sites you own or are authorised to test. Every test is checked against the target's host allow-list and its rate, duration and request ceilings — on the server, not just in this form.</p>
      <Card title={editingId ? 'Edit target' : 'Register a target'}>
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
          <div className="rounded-md border border-line p-3 md:col-span-2 space-y-3">
            <label className="flex items-start gap-2"><input type="checkbox" checked={form.stressAuthorized} onChange={(e) => set('stressAuthorized', e.target.checked)} />
              <span>I own this site and authorise stress tests (heavy traffic, breaking-point search)<span className="block text-xs text-muted">Separate opt-in from normal load tests. Use staging or a quiet window; a stress test that finds the limit can take the site down.</span></span></label>
            {form.stressAuthorized && <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Field label="Max bots"><input type="number" min={1} value={form.stressMaxBots} onChange={(e) => set('stressMaxBots', +e.target.value)} /></Field>
              <Field label="Max req/s"><input type="number" min={1} value={form.stressMaxRps} onChange={(e) => set('stressMaxRps', +e.target.value)} /></Field>
              <Field label="Max seconds"><input type="number" min={10} value={form.stressMaxDurationSec} onChange={(e) => set('stressMaxDurationSec', +e.target.value)} /></Field>
              <Field label="Request budget"><input type="number" min={100} value={form.stressMaxRequests} onChange={(e) => set('stressMaxRequests', +e.target.value)} /></Field>
              <Field label="Docker container" hint="Optional, for CPU/memory"><input value={form.containerName} onChange={(e) => set('containerName', e.target.value)} placeholder="my-app" /></Field>
            </div>}
          </div>
          <div className="md:col-span-2 space-y-3"><ErrorBox error={error} /><div className="flex gap-2"><Btn type="submit">{editingId ? 'Save changes' : 'Add target'}</Btn>{editingId && <Btn type="button" variant="ghost" onClick={() => { setEditingId(null); setForm(blank); }}>Cancel</Btn>}</div></div>
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
                <td className="text-xs text-muted">{[t.allowPrivateNetwork && 'private net', t.activeScanAuthorized && 'active scans OK', t.stressAuthorized && `stress ≤ ${t.stressMaxBots} bots`].filter(Boolean).join(', ') || '—'}</td>
                <td className="space-x-2 text-right"><Btn variant="ghost" onClick={() => edit(t)}>Edit</Btn><Btn variant="ghost" onClick={() => remove(t)}>Delete</Btn></td>
              </tr>))}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
