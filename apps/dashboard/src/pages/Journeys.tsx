import { useEffect, useState } from 'react';
import type { JourneyStep } from '@siteguard/contracts';
import { api, type Journey, type Target } from '../api';
import { Btn, Card, ErrorBox, Field } from '../ui';

const blankStep = (n: number): JourneyStep => ({
  name: `step ${n}`, method: 'GET', path: '/', headers: {}, bodyType: 'none', body: '', extract: [], checks: [], thinkMs: 1000, kind: 'normal',
});

const HINT = 'Use {{name}} for a value extracted by an earlier step, {{data.field}} for a column of the dataset (a different row per bot), and {{env.SG_NAME}} for a secret from your .env file (never stored in the database).';

function StepEditor({ step, index, onChange, onRemove, onMove }: { step: JourneyStep; index: number; onChange: (s: JourneyStep) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const set = <K extends keyof JourneyStep>(k: K, v: JourneyStep[K]) => onChange({ ...step, [k]: v });
  return (
    <div className="space-y-3 rounded-md border border-line p-3">
      <div className="flex items-center gap-2">
        <span className="w-6 text-xs text-muted">#{index + 1}</span>
        <input className="flex-1" value={step.name} onChange={(e) => set('name', e.target.value)} aria-label="Step name" />
        <select className="!w-24" value={step.method} onChange={(e) => set('method', e.target.value as JourneyStep['method'])}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select>
        <select className="!w-32" value={step.kind} onChange={(e) => set('kind', e.target.value as JourneyStep['kind'])}><option value="normal">normal</option><option value="verify">verify (after)</option></select>
        <Btn variant="ghost" onClick={() => onMove(-1)}>↑</Btn><Btn variant="ghost" onClick={() => onMove(1)}>↓</Btn><Btn variant="ghost" onClick={onRemove}>✕</Btn>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Path"><input value={step.path} onChange={(e) => set('path', e.target.value)} placeholder="/shop/search?q={{data.term}}" /></Field>
        <Field label="Body type"><select value={step.bodyType} onChange={(e) => set('bodyType', e.target.value as JourneyStep['bodyType'])}><option value="none">none</option><option value="json">json</option><option value="form">form (a=1&amp;b=2)</option></select></Field>
        <Field label="Think time (ms)"><input type="number" min={0} value={step.thinkMs} onChange={(e) => set('thinkMs', +e.target.value)} /></Field>
        {step.bodyType !== 'none' && <div className="md:col-span-3"><Field label="Body"><textarea rows={2} value={step.body} onChange={(e) => set('body', e.target.value)} /></Field></div>}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs text-muted">Extract values for later steps</div>
          {step.extract.map((x, i) => (
            <div key={i} className="flex gap-2">
              <input className="!w-28" placeholder="name" value={x.var} onChange={(e) => set('extract', step.extract.map((y, j) => (j === i ? { ...y, var: e.target.value } : y)))} />
              <select className="!w-24" value={x.from} onChange={(e) => set('extract', step.extract.map((y, j) => (j === i ? { ...y, from: e.target.value as 'json' } : y)))}><option>json</option><option>header</option><option>regex</option></select>
              <input className="flex-1" placeholder={x.from === 'json' ? 'cart.id' : x.from === 'header' ? 'X-Token' : 'id="(\\d+)"'} value={x.expr} onChange={(e) => set('extract', step.extract.map((y, j) => (j === i ? { ...y, expr: e.target.value } : y)))} />
              <Btn variant="ghost" onClick={() => set('extract', step.extract.filter((_, j) => j !== i))}>✕</Btn>
            </div>
          ))}
          <Btn variant="ghost" onClick={() => set('extract', [...step.extract, { var: '', from: 'json', expr: '' }])}>+ extract</Btn>
        </div>
        <div className="space-y-2">
          <div className="text-xs text-muted">Checks (a failing check is counted, and a failed status ends the journey for that bot)</div>
          {step.checks.map((c, i) => (
            <div key={i} className="flex gap-2">
              <input className="!w-24" type="number" placeholder="status" value={c.status ?? ''} onChange={(e) => set('checks', step.checks.map((y, j) => (j === i ? { ...y, status: e.target.value ? +e.target.value : undefined } : y)))} />
              <input className="flex-1" placeholder="body contains…" value={c.bodyIncludes ?? ''} onChange={(e) => set('checks', step.checks.map((y, j) => (j === i ? { ...y, bodyIncludes: e.target.value || undefined } : y)))} />
              <input className="!w-40" placeholder="equal fields a,b" value={c.equalFields?.join(',') ?? ''} onChange={(e) => { const [a, b] = e.target.value.split(','); set('checks', step.checks.map((y, j) => (j === i ? { ...y, equalFields: a && b ? [a.trim(), b.trim()] : undefined } : y))); }} />
              <Btn variant="ghost" onClick={() => set('checks', step.checks.filter((_, j) => j !== i))}>✕</Btn>
            </div>
          ))}
          <Btn variant="ghost" onClick={() => set('checks', [...step.checks, { status: 200 }])}>+ check</Btn>
        </div>
      </div>
    </div>
  );
}

export default function Journeys() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState('');
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [editing, setEditing] = useState<{ id?: string; name: string; steps: JourneyStep[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => { api<Target[]>('/targets').then((t) => { setTargets(t); setTargetId((c) => c || t[0]?.id || ''); }); }, []);
  const load = () => targetId ? api<Journey[]>(`/targets/${targetId}/journeys`).then(setJourneys) : undefined;
  useEffect(() => { load(); setEditing(null); }, [targetId]);

  const save = async () => {
    if (!editing) return;
    setError(null);
    try {
      const body = JSON.stringify({ name: editing.name, steps: editing.steps });
      const res = await api<Journey>(editing.id ? `/journeys/${editing.id}` : `/targets/${targetId}/journeys`, { method: editing.id ? 'PUT' : 'POST', body });
      setWarnings(res.warnings ?? []);
      setEditing(null);
      load();
    } catch (e) { setError((e as Error).message); }
  };
  const remove = async (j: Journey) => { if (confirm(`Delete journey "${j.name}"?`)) { await api(`/journeys/${j.id}`, { method: 'DELETE' }); load(); } };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Journeys</h1>
      <p className="max-w-3xl text-muted">A journey is what one bot does: log in, search, add to cart, check out. Bots keep their own cookies and values, so each one is a separate user. Every path is checked against the target&apos;s approved hosts before a stress test starts.</p>
      {targets.length === 0 ? <Card><p>Register a target first.</p></Card> : (
        <Card title="Target" action={<select className="!w-64" value={targetId} onChange={(e) => setTargetId(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}>
          {warnings.map((w) => <p key={w} className="mb-2 text-sm text-orange-200">{w}</p>)}
          {journeys.length === 0 ? <p className="text-muted">No journeys yet.</p> : (
            <table><thead><tr><th>Name</th><th>Steps</th><th /></tr></thead><tbody>
              {journeys.map((j) => (<tr key={j.id}><td className="font-medium">{j.name}</td><td className="text-xs text-muted">{j.steps.map((s) => `${s.method} ${s.name}`).join(' → ')}</td>
                <td className="space-x-2 text-right"><Btn variant="ghost" onClick={() => { setWarnings([]); setEditing({ id: j.id, name: j.name, steps: j.steps }); }}>Edit</Btn><Btn variant="ghost" onClick={() => remove(j)}>Delete</Btn></td></tr>))}
            </tbody></table>
          )}
          {!editing && <div className="mt-4"><Btn onClick={() => setEditing({ name: '', steps: [blankStep(1)] })}>New journey</Btn></div>}
        </Card>
      )}
      {editing && (
        <Card title={editing.id ? 'Edit journey' : 'New journey'}>
          <div className="space-y-4">
            <Field label="Journey name"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Shopper: browse and check out" /></Field>
            <p className="text-xs text-muted">{HINT}</p>
            {editing.steps.map((s, i) => (
              <StepEditor key={i} step={s} index={i}
                onChange={(n) => setEditing({ ...editing, steps: editing.steps.map((x, j) => (j === i ? n : x)) })}
                onRemove={() => setEditing({ ...editing, steps: editing.steps.filter((_, j) => j !== i) })}
                onMove={(d) => { const to = i + d; if (to < 0 || to >= editing.steps.length) return; const next = [...editing.steps]; [next[i], next[to]] = [next[to]!, next[i]!]; setEditing({ ...editing, steps: next }); }} />
            ))}
            <div className="flex gap-2"><Btn variant="ghost" onClick={() => setEditing({ ...editing, steps: [...editing.steps, blankStep(editing.steps.length + 1)] })}>+ Add step</Btn></div>
            <ErrorBox error={error} />
            <div className="flex gap-2"><Btn onClick={save} disabled={!editing.name.trim()}>Save journey</Btn><Btn variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn></div>
          </div>
        </Card>
      )}
    </div>
  );
}
