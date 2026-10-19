import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, estimateRequests, type Run, type RunType, type Target } from '../api';
import { Badge, Btn, Card, ErrorBox, Field, TYPE_LABEL, runResult, when } from '../ui';

const COPY: Record<RunType, string> = {
  LOAD: 'Ramps up to a fixed arrival rate using k6. The target\'s req/s ceiling, duration limit and request budget are enforced before the run starts; error-rate and latency stop rules end it early.',
  CRAWL: 'Discovers pages within the approved hosts, following redirects hop-by-hop (each hop is scope-checked) and reporting broken links, redirect chains and missing metadata.',
  SECURITY: 'Passive checks inspect headers, cookies, TLS and a handful of commonly exposed files. OWASP ZAP runs in Docker and is optional.',
};

export default function Launcher({ type }: { type: RunType }) {
  const nav = useNavigate();
  const [targets, setTargets] = useState<Target[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [load, setLoad] = useState({ paths: '/', rps: 1, maxVus: 10, durationSec: 30, rampUpSec: 5, maxErrorPct: 50, maxP95Ms: 10000 });
  const [crawl, setCrawl] = useState({ startPath: '/', maxPages: 50, maxDepth: 3, rps: 2, renderJs: false });
  const [sec, setSec] = useState({ zapBaseline: false, zapActive: false });

  useEffect(() => {
    api<Target[]>('/targets').then((t) => { setTargets(t); setTargetId((cur) => cur || t[0]?.id || ''); });
    api<Run[]>(`/runs?type=${type}&limit=10`).then(setRuns);
  }, [type]);
  const target = targets.find((t) => t.id === targetId);
  const est = estimateRequests(load.rps, load.durationSec, load.rampUpSec);

  const start = async () => {
    setError(null); setBusy(true);
    try {
      const config =
        type === 'LOAD' ? { paths: load.paths.split(/[\s,]+/).filter(Boolean), rps: load.rps, maxVus: load.maxVus, durationSec: load.durationSec, rampUpSec: load.rampUpSec,
          stopRules: { maxErrorRate: load.maxErrorPct / 100, maxP95Ms: load.maxP95Ms } }
        : type === 'CRAWL' ? crawl : { passive: true, ...sec };
      const run = await api<Run>('/runs', { method: 'POST', body: JSON.stringify({ type, targetId, config }) });
      nav(`/runs/${run.id}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const num = (setter: (f: any) => void, k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setter((f: any) => ({ ...f, [k]: +e.target.value }));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{type === 'LOAD' ? 'Load tests' : type === 'CRAWL' ? 'Crawler' : 'Security scans'}</h1>
      <p className="max-w-3xl text-muted">{COPY[type]}</p>
      {targets.length === 0 ? <Card><p>Register a target first on the <Link className="text-accent underline" to="/targets">Targets</Link> page.</p></Card> : (
        <Card title="New run">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Target">
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>{targets.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.baseUrl}</option>)}</select>
            </Field>
            {type === 'LOAD' && <>
              <Field label="Paths to request" hint="Comma or newline separated; picked at random."><textarea rows={2} value={load.paths} onChange={(e) => setLoad({ ...load, paths: e.target.value })} /></Field>
              <Field label={`Target req/s (ceiling ${target?.maxRps ?? '—'})`}><input type="number" min={1} value={load.rps} onChange={num(setLoad, 'rps')} /></Field>
              <Field label="Duration (s)" hint={target ? `limit ${target.maxDurationSec}s` : ''}><input type="number" min={5} value={load.durationSec} onChange={num(setLoad, 'durationSec')} /></Field>
              <Field label="Ramp-up (s)"><input type="number" min={0} value={load.rampUpSec} onChange={num(setLoad, 'rampUpSec')} /></Field>
              <Field label="Max virtual users"><input type="number" min={1} value={load.maxVus} onChange={num(setLoad, 'maxVus')} /></Field>
              <Field label="Stop if error rate exceeds (%)"><input type="number" min={0} max={100} value={load.maxErrorPct} onChange={num(setLoad, 'maxErrorPct')} /></Field>
              <Field label="Stop if p95 exceeds (ms)"><input type="number" min={10} value={load.maxP95Ms} onChange={num(setLoad, 'maxP95Ms')} /></Field>
              <div className={`self-end text-sm ${target && est > target.maxRequests ? 'text-red-300' : 'text-muted'}`}>≈ {est.toLocaleString()} requests{target && ` of ${target.maxRequests.toLocaleString()} budget`}</div>
            </>}
            {type === 'CRAWL' && <>
              <Field label="Start path"><input value={crawl.startPath} onChange={(e) => setCrawl({ ...crawl, startPath: e.target.value })} /></Field>
              <Field label="Max pages"><input type="number" min={1} value={crawl.maxPages} onChange={num(setCrawl, 'maxPages')} /></Field>
              <Field label="Max depth"><input type="number" min={0} value={crawl.maxDepth} onChange={num(setCrawl, 'maxDepth')} /></Field>
              <Field label="Requests per second (max 20)"><input type="number" min={1} max={20} value={crawl.rps} onChange={num(setCrawl, 'rps')} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={crawl.renderJs} onChange={(e) => setCrawl({ ...crawl, renderJs: e.target.checked })} /> Render JavaScript (Chromium)</label>
            </>}
            {type === 'SECURITY' && <div className="space-y-2 md:col-span-2">
              <label className="flex items-center gap-2"><input type="checkbox" checked disabled /> Passive checks (headers, cookies, TLS, exposed files) — always on</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={sec.zapBaseline} onChange={(e) => setSec({ ...sec, zapBaseline: e.target.checked })} /> OWASP ZAP baseline scan <span className="text-xs text-muted">(Docker; first run downloads a large image)</span></label>
              <label className="flex items-center gap-2"><input type="checkbox" disabled={!target?.activeScanAuthorized} checked={sec.zapActive} onChange={(e) => setSec({ ...sec, zapActive: e.target.checked })} /> OWASP ZAP <b>active</b> scan <span className="text-xs text-muted">{target?.activeScanAuthorized ? 'sends attack payloads — only against your own site' : '(target not marked as authorised for active scans)'}</span></label>
            </div>}
          </div>
          <div className="mt-4 space-y-3"><ErrorBox error={error} /><Btn onClick={start} disabled={busy || !targetId}>{busy ? 'Starting…' : 'Start'}</Btn></div>
        </Card>
      )}
      <Card title={`Recent ${TYPE_LABEL[type].toLowerCase()}s`}>
        {runs.length === 0 ? <p className="text-muted">No runs yet.</p> : (
          <table><thead><tr><th>When</th><th>Target</th><th>Status</th><th>Result</th></tr></thead><tbody>
            {runs.map((r) => (<tr key={r.id}><td><Link className="text-accent" to={`/runs/${r.id}`}>{when(r.createdAt)}</Link></td><td>{r.target?.name}</td><td><Badge kind={r.status} /></td>
              <td className="text-muted">{runResult(r)}</td></tr>))}
          </tbody></table>
        )}
      </Card>
    </div>
  );
}
