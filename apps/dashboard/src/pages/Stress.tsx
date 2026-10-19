import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StressConfig, botLevels, botSchedule, estimateStressRequests, minGapMs, scheduleStats } from '@siteguard/contracts';
import { api, type Journey, type Run, type Target } from '../api';
import { Badge, Btn, Card, ErrorBox, Field, runResult, when } from '../ui';

const PROFILES = {
  step: 'Stepped ramp: hold at each level so you can see exactly which load causes trouble.',
  ramp: 'Continuous ramp: keep adding bots until the site breaks; best for finding the exact limit.',
  spike: 'Spike: a sudden burst, then back to baseline; models a flash sale or a viral moment.',
  soak: 'Soak: hold a high level for a long time; reveals leaks and slow degradation.',
  quick: 'Quick check (like ab -n 1000 -c 100): a fixed number of requests at a fixed concurrency.',
} as const;
type Profile = keyof typeof PROFILES;

const CONFIRM = 'I own this site';

export default function Stress() {
  const nav = useNavigate();
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState('');
  const [journeys, setJourneys] = useState<Journey[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [paths, setPaths] = useState('');
  const [f, setF] = useState({
    hypothesis: '', profile: 'step' as Profile, engine: 'protocol' as 'protocol' | 'hybrid', browserBots: 3,
    startBots: 2, mode: 'multiply' as 'add' | 'multiply', amount: 5, factor: 2, intervalSec: 30, maxBots: 32, holdSec: 60,
    requests: 1000, concurrency: 10, recover: true, recoverSec: 60, recoverBots: 1, dataset: '', maxErrorPct: 50, maxP95Ms: 10000, stopAtBp: true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }));
  const num = <K extends keyof typeof f>(k: K) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, +e.target.value as never);

  useEffect(() => {
    api<Target[]>('/targets').then((t) => { setTargets(t); setTargetId((c) => c || t.find((x) => x.stressAuthorized)?.id || t[0]?.id || ''); });
    api<Run[]>('/runs?type=STRESS&limit=10').then(setRuns);
  }, []);
  useEffect(() => { if (targetId) api<Journey[]>(`/targets/${targetId}/journeys`).then((j) => { setJourneys(j); setPicked({}); }); }, [targetId]);
  const target = targets.find((t) => t.id === targetId);

  const config = useMemo(() => {
    const mix = [
      ...Object.entries(picked).filter(([, w]) => w > 0).map(([journeyId, weight]) => ({ journeyId, weight })),
      ...(paths.trim() ? [{ paths: paths.split(/[\s,]+/).filter(Boolean), weight: 1 }] : []),
    ];
    return {
      hypothesis: f.hypothesis, profile: f.profile, engine: f.engine, browserBots: f.browserBots, mix, startBots: f.startBots,
      growth: { mode: f.mode, amount: f.amount, factor: f.factor }, intervalSec: f.intervalSec, maxBots: f.maxBots, holdSec: f.holdSec,
      requests: f.requests, concurrency: f.concurrency, recovery: { enabled: f.recover, holdSec: f.recoverSec, bots: f.recoverBots },
      dataset: f.dataset.trim() || undefined, stopRules: { maxErrorRate: f.maxErrorPct / 100, maxP95Ms: f.maxP95Ms }, stopAtBreakingPoint: f.stopAtBp,
    };
  }, [f, picked, paths]);

  const parsed = useMemo(() => StressConfig.safeParse(config), [config]);
  // The preview only needs the schedule, so fill in the two required text fields while the form is still incomplete.
  const previewCfg = useMemo(() => StressConfig.safeParse({ ...config, hypothesis: config.hypothesis || 'preview', mix: config.mix.length ? config.mix : [{ paths: ['/'] }] }), [config]);
  const preview = useMemo(() => {
    if (!previewCfg.success) return null;
    const cfg = previewCfg.data;
    const stages = botSchedule(cfg);
    const stats = scheduleStats(stages);
    return {
      levels: cfg.profile === 'quick' ? [cfg.concurrency] : botLevels(cfg), stats, gap: minGapMs(cfg.profile === 'quick' ? cfg.concurrency : stats.peakBots, target?.stressMaxRps ?? 100),
      estimate: estimateStressRequests(cfg, target?.stressMaxRps ?? 100),
    };
  }, [previewCfg, target]);

  const problems: string[] = [];
  if (target && !target.stressAuthorized) problems.push('This target is not marked "stress tests authorised". Tick it under Edit on the Targets page.');
  if (target && preview) {
    if (f.maxBots > target.stressMaxBots) problems.push(`Max bots ${f.maxBots} is over this target's stress ceiling of ${target.stressMaxBots}.`);
    if (f.profile !== 'quick' && preview.stats.durationSec > target.stressMaxDurationSec) problems.push(`The schedule runs ${preview.stats.durationSec}s, over the ${target.stressMaxDurationSec}s limit.`);
    if (preview.estimate > target.stressMaxRequests) problems.push(`Up to ~${preview.estimate.toLocaleString()} requests, over the ${target.stressMaxRequests.toLocaleString()} budget.`);
  }
  if (!parsed.success)
    problems.push(...parsed.error.issues.map((i) => (i.path[0] === 'mix' ? 'Pick at least one journey (give it a weight above 0) or list a path.'
      : i.path[0] === 'hypothesis' ? 'Write a hypothesis: what do you expect to happen?' : `${i.path.join('.') || 'config'}: ${i.message}`)));

  const start = async () => {
    setError(null); setBusy(true);
    try {
      const run = await api<Run>('/runs', { method: 'POST', body: JSON.stringify({ type: 'STRESS', targetId, config }) });
      nav(`/runs/${run.id}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Stress tests</h1>
      <p className="max-w-3xl text-muted">Adds bots at every interval until the site shows strain, then drops the load and checks whether it recovers. Each bot is a separate user running a journey. From outside we can see latency, errors and throughput, not server memory or query plans, so causes are reported as indicators to check, not proof.</p>
      <div className="max-w-3xl rounded-md border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-sm text-orange-200">A stress test that finds the limit can take the site down. Use staging or a low-traffic window, and keep the ceilings in the target settings. Your own machine&apos;s CPU and network also cap how much traffic it can generate.</div>
      {targets.length === 0 ? <Card><p>Register a target first on the <Link className="text-accent underline" to="/targets">Targets</Link> page.</p></Card> : (
        <Card title="New stress test">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Target"><select value={targetId} onChange={(e) => setTargetId(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.stressAuthorized ? '' : ' (stress not authorised)'}</option>)}</select></Field>
            <div className="md:col-span-2"><Field label="Hypothesis (what do you expect to happen?)" hint="Write it down before you run it, e.g. “p95 stays under 500 ms up to 32 bots”."><input value={f.hypothesis} onChange={(e) => set('hypothesis', e.target.value)} /></Field></div>
            <Field label="Profile"><select value={f.profile} onChange={(e) => set('profile', e.target.value as Profile)}>{Object.keys(PROFILES).map((p) => <option key={p}>{p}</option>)}</select></Field>
            <p className="self-end text-xs text-muted md:col-span-2">{PROFILES[f.profile]}</p>

            <div className="space-y-2 md:col-span-3">
              <div className="text-xs text-muted">Traffic mix (relative weights, e.g. browse 70 / checkout 10)</div>
              {journeys.length === 0 && <p className="text-sm text-muted">No journeys for this target yet. Create one on the <Link className="text-accent underline" to="/journeys">Journeys</Link> page, or just list paths below.</p>}
              {journeys.map((j) => (
                <div key={j.id} className="flex items-center gap-3"><input type="number" className="!w-20" min={0} max={100} value={picked[j.id] ?? 0} onChange={(e) => setPicked({ ...picked, [j.id]: +e.target.value })} /><span>{j.name}</span><span className="text-xs text-muted">{j.steps.length} steps</span></div>
              ))}
              <Field label="Or plain GET paths" hint="Comma or newline separated."><input value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="/, /products" /></Field>
            </div>

            {f.profile === 'quick' ? <>
              <Field label="Total requests (ab -n)"><input type="number" min={10} value={f.requests} onChange={num('requests')} /></Field>
              <Field label="Concurrency (ab -c)"><input type="number" min={1} value={f.concurrency} onChange={num('concurrency')} /></Field>
            </> : <>
              <Field label="Start bots"><input type="number" min={1} value={f.startBots} onChange={num('startBots')} /></Field>
              <Field label="Bots per interval"><select value={f.mode} onChange={(e) => set('mode', e.target.value as 'add' | 'multiply')}><option value="multiply">multiply by a factor</option><option value="add">add a fixed number</option></select></Field>
              {f.mode === 'multiply' ? <Field label="Factor (×2 doubles each interval)"><input type="number" step="0.1" min={1.1} value={f.factor} onChange={num('factor')} /></Field>
                : <Field label="Bots added each interval"><input type="number" min={1} value={f.amount} onChange={num('amount')} /></Field>}
              <Field label="Interval (s)"><input type="number" min={5} value={f.intervalSec} onChange={num('intervalSec')} /></Field>
              <Field label={`Max bots (ceiling ${target?.stressMaxBots ?? '—'})`}><input type="number" min={1} value={f.maxBots} onChange={num('maxBots')} /></Field>
              {(f.profile === 'spike' || f.profile === 'soak') && <Field label={f.profile === 'spike' ? 'Spike length (s)' : 'Hold at max (s)'}><input type="number" min={5} value={f.holdSec} onChange={num('holdSec')} /></Field>}
            </>}

            <Field label="Engine"><select value={f.engine} onChange={(e) => set('engine', e.target.value as 'protocol' | 'hybrid')}><option value="protocol">Protocol bots (HTTP only)</option><option value="hybrid">Hybrid: add a few real-browser bots</option></select></Field>
            {f.engine === 'hybrid' && <Field label="Browser bots (each is a full Chromium)"><input type="number" min={0} max={20} value={f.browserBots} onChange={num('browserBots')} /></Field>}
            <Field label="Dataset file (in datasets/)" hint="JSON array or CSV; each bot uses a different row."><input value={f.dataset} onChange={(e) => set('dataset', e.target.value)} placeholder="users.json" /></Field>
            <Field label="Stop if error rate exceeds (%)"><input type="number" min={0} max={100} value={f.maxErrorPct} onChange={num('maxErrorPct')} /></Field>
            <Field label="Stop if p95 exceeds (ms)"><input type="number" min={10} value={f.maxP95Ms} onChange={num('maxP95Ms')} /></Field>
            <div className="space-y-2 md:col-span-3">
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.stopAtBp} onChange={(e) => set('stopAtBp', e.target.checked)} /> Stop adding bots once the breaking point is found</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.recover} onChange={(e) => set('recover', e.target.checked)} /> After the peak, drop the load and measure recovery
                {f.recover && <><span className="text-xs text-muted">for</span><input type="number" className="!w-20" min={10} value={f.recoverSec} onChange={num('recoverSec')} /><span className="text-xs text-muted">s with</span><input type="number" className="!w-16" min={1} value={f.recoverBots} onChange={num('recoverBots')} /><span className="text-xs text-muted">bot(s)</span></>}</label>
            </div>
          </div>

          {preview && (
            <div className="mt-4 rounded-md border border-line p-3 text-sm">
              <div className="mb-1 text-xs text-muted">Plan preview</div>
              <div className="flex flex-wrap items-center gap-1 font-mono">{preview.levels.map((b, i) => <span key={i} className="flex items-center gap-1">{i > 0 && <span className="text-muted">→</span>}<span className="rounded bg-white/10 px-2 py-0.5">{b}</span></span>)}<span className="ml-2 text-xs text-muted">bots</span></div>
              <div className="mt-2 text-muted">{f.profile === 'quick' ? `${f.requests.toLocaleString()} requests` : `${preview.stats.durationSec}s total, up to ~${preview.estimate.toLocaleString()} requests`} · each bot pauses at least {preview.gap} ms between requests so the {target?.stressMaxRps ?? '—'} req/s ceiling holds</div>
            </div>
          )}
          {problems.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-red-300">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <div className="mt-4 space-y-3">
            <ErrorBox error={error} />
            <Field label={`Type “${CONFIRM}” to enable the Start button`}><input className="!w-64" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            <Btn onClick={start} disabled={busy || !targetId || confirm !== CONFIRM || problems.length > 0}>{busy ? 'Starting…' : 'Start stress test'}</Btn>
          </div>
        </Card>
      )}
      <Card title="Recent stress tests">
        {runs.length === 0 ? <p className="text-muted">No stress tests yet.</p> : (
          <table><thead><tr><th>When</th><th>Target</th><th>Status</th><th>Result</th></tr></thead><tbody>
            {runs.map((r) => (<tr key={r.id}><td><Link className="text-accent" to={`/runs/${r.id}`}>{when(r.createdAt)}</Link></td><td>{r.target?.name}</td><td><Badge kind={r.status} /></td><td className="text-muted">{runResult(r)}</td></tr>))}
          </tbody></table>
        )}
      </Card>
    </div>
  );
}
