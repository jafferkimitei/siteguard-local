import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  StressConfig, buildStressScript, classifyFailurePattern, detectBreakingPoint, evaluateRecovery, healthVerdicts, latencyDrift, stepRefs, ENV_REF,
  type BreakingPoint, type JourneyInput, type LevelStats, type MetricPointDTO, type Phase, type Recovery, type Stage, type StepStats, type StressSummary,
} from '@siteguard/contracts';
import { datasetsDir, prisma } from '@siteguard/database';
import { SafetyError, assertDestinationAllowed, evaluateStopRules, loadDataset, percentile, validateJourney, validateStressPlan, type PlannedStress } from '@siteguard/safety';
import { audit, errMessage, saveFindings, type RunnerResult, type RunWithTarget } from './common';
import { bottleneckFindings } from './bottlenecks';
import { METADATA_CIDRS, MetricsCollector, PRIVATE_CIDRS, engineError, runK6, type K6Record } from './k6run';
import { makeWorkDir, removeDir } from './proc';
import { startBrowserBots, type BrowserBotResult } from './browserbots';
import { startDockerStats } from './dockerstats';

type RunJourney = JourneyInput & { weight: number };

// ---------------------------------------------------------------------------------------

/** Turn the run's mix into concrete journeys (path entries become one single-step journey per path). */
export async function resolveJourneys(run: RunWithTarget, cfg: StressConfig): Promise<RunJourney[]> {
  const ids = cfg.mix.flatMap((m) => (m.journeyId ? [m.journeyId] : []));
  const stored = ids.length ? await prisma.journey.findMany({ where: { id: { in: ids }, targetId: run.targetId } }) : [];
  const out: RunJourney[] = [];
  for (const m of cfg.mix) {
    if (m.journeyId) {
      const j = stored.find((s) => s.id === m.journeyId);
      if (!j) throw new SafetyError(`Journey ${m.journeyId} was not found for this target`);
      out.push({ name: j.name, steps: j.steps as never, weight: m.weight });
    } else {
      for (const p of m.paths ?? [])
        out.push({ name: `GET ${p}`, weight: m.weight, steps: [{ name: p, method: 'GET', path: p, headers: {}, bodyType: 'none', body: '', extract: [], checks: [], thinkMs: 0, kind: 'normal' }] });
    }
  }
  return out;
}

const stageBounds = (stages: Stage[]) => {
  let t = 0;
  return stages.map((s) => ({ stage: s, start: t, end: (t += s.durationSec) }));
};

interface Level { stage: Stage; durations: number[]; failed: number }

const kindOf = (rec: K6Record) => {
  const code = Number(rec.tags.error_code ?? 0);
  if (code === 1050 || code === 1111) return 'timeout';
  if (code === 1112) return 'connection refused';
  if (code >= 1130 && code <= 1135) return 'connection reset';
  return 'network error';
};

/** Everything measured during one k6 invocation. */
class Tally {
  levels: Level[];
  steps = new Map<string, { journey: string; step: string; durations: number[]; failed: number; statusCounts: Record<string, number> }>();
  statusCounts: Record<string, number> = {};
  errorKinds: Record<string, number> = {};
  cacheHit = 0;
  cacheMiss = 0;
  waf = 0;
  integrity = { checks: 0, failures: 0 };
  recoveryWindows = new Map<number, number[]>();
  recoveryFailed = new Map<number, number>();
  t0: number | null = null;
  lastRel = 0;
  bounds: ReturnType<typeof stageBounds>;
  constructor(stages: Stage[], private settleFrom: (s: Stage) => number) {
    this.bounds = stageBounds(stages);
    this.levels = stages.map((stage) => ({ stage, durations: [], failed: 0 }));
  }
  rel(sec: number) {
    return this.t0 === null ? 0 : sec - this.t0;
  }
  stageIndex(rel: number) {
    const i = this.bounds.findIndex((b) => rel >= b.start && rel < b.end);
    return i === -1 ? this.bounds.length - 1 : i;
  }
  record(rec: K6Record) {
    if (this.t0 === null) this.t0 = rec.sec;
    this.lastRel = Math.max(this.lastRel, rec.sec - this.t0);
    if (rec.metric === 'sg_cache_hit') this.cacheHit += rec.value;
    else if (rec.metric === 'sg_cache_miss') this.cacheMiss += rec.value;
    else if (rec.metric === 'sg_waf_block') this.waf += rec.value;
    else if (rec.metric === 'checks' && rec.tags.kind === 'verify') {
      this.integrity.checks++;
      if (rec.value === 0) this.integrity.failures++;
    } else if (rec.metric === 'http_req_duration' && rec.tags.kind !== 'verify') {
      const ok = rec.tags.expected_response === 'true';
      const status = rec.tags.status ?? '0';
      this.statusCounts[status] = (this.statusCounts[status] ?? 0) + 1;
      if (status === '0') {
        const k = kindOf(rec);
        this.errorKinds[k] = (this.errorKinds[k] ?? 0) + 1;
      }
      const key = `${rec.tags.journey ?? ''}\u0000${rec.tags.step ?? rec.tags.name ?? ''}`;
      let s = this.steps.get(key);
      if (!s) this.steps.set(key, (s = { journey: rec.tags.journey ?? '', step: rec.tags.step ?? rec.tags.name ?? '', durations: [], failed: 0, statusCounts: {} }));
      s.durations.push(rec.value);
      s.statusCounts[status] = (s.statusCounts[status] ?? 0) + 1;
      if (!ok) s.failed++;
      const rel = this.rel(rec.sec);
      const i = this.stageIndex(rel);
      const b = this.bounds[i]!;
      if (rel - b.start >= this.settleFrom(b.stage)) {
        this.levels[i]!.durations.push(rec.value);
        if (!ok) this.levels[i]!.failed++;
      }
    }
  }
  levelStats(i: number): LevelStats {
    const l = this.levels[i]!;
    const sorted = [...l.durations].sort((a, b) => a - b);
    const b = this.bounds[i]!;
    // A level that was cut short only had `lastRel - start - settle` seconds of settled data.
    const window = Math.max(1, Math.min(l.stage.durationSec - this.settleFrom(l.stage), this.lastRel - b.start - this.settleFrom(l.stage) + 1));
    return {
      bots: l.stage.bots, rps: sorted.length / window, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99),
      errorRate: sorted.length ? l.failed / sorted.length : 0, requests: sorted.length,
    };
  }
  stepStats(): StepStats[] {
    return [...this.steps.values()].map((s) => {
      const sorted = [...s.durations].sort((a, b) => a - b);
      return { journey: s.journey, step: s.step, requests: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99),
        errorRate: sorted.length ? s.failed / sorted.length : 0, statusCounts: s.statusCounts };
    });
  }
}

/** Redact secret values from any text that could reach the audit log or the UI. */
const redactor = (secrets: Record<string, string>) => (text: string) =>
  Object.values(secrets).filter((v) => v.length >= 3).reduce((t, v) => t.split(v).join('***'), text);

export async function runStress(run: RunWithTarget): Promise<RunnerResult> {
  const { target } = run;
  const cfg = StressConfig.parse(run.config);
  const plan: PlannedStress = validateStressPlan(cfg, target); // re-check: config could have been edited in the DB
  const journeys = await resolveJourneys(run, cfg);
  for (const j of journeys) await validateJourney(j, target, { hasDataset: !!cfg.dataset });
  await assertDestinationAllowed(target.baseUrl, target);

  // Secrets: only SG_* variables referenced by the chosen journeys, read from the environment, never from the DB.
  const secrets: Record<string, string> = {};
  for (const ref of journeys.flatMap((j) => j.steps.flatMap(stepRefs))) {
    const m = ENV_REF.exec(ref);
    if (!m) continue;
    const v = process.env[m[1]!];
    if (v === undefined) throw new SafetyError(`Environment variable ${m[1]} is referenced by a journey but is not set. Add it to your .env file.`);
    secrets[m[1]!] = v;
  }
  const redact = redactor(secrets);

  const workDir = makeWorkDir(run.id);
  try {
    writeFileSync(join(workDir, 'secrets.json'), JSON.stringify(secrets));
    chmodSync(join(workDir, 'secrets.json'), 0o644); // the k6 container runs as a different uid; the file lives in a private, deleted-after-run folder
    writeFileSync(join(workDir, 'dataset.json'), cfg.dataset ? loadDataset(datasetsDir, cfg.dataset) : '[]');

    const origin = new URL(target.baseUrl).origin;
    const loadStages = plan.stages.filter((s) => s.phase !== 'recovery');
    const recoveryStage = plan.stages.find((s) => s.phase === 'recovery');
    const hasVerify = journeys.some((j) => j.steps.some((s) => s.kind === 'verify'));
    const stepsPerIteration = Math.max(1, journeys.reduce((a, j) => a + j.steps.filter((s) => s.kind === 'normal').length * j.weight, 0) / Math.max(1, journeys.reduce((a, j) => a + j.weight, 0)));

    const baseCfg = {
      journeys, gapMs: plan.gapMs, hasData: !!cfg.dataset, profile: cfg.profile, concurrency: cfg.concurrency,
      iterations: Math.ceil(cfg.requests / stepsPerIteration), recoveryBots: 0, recoverySec: 0, stages: loadStages,
    };
    const scriptEnv = (mode: 'load' | 'tail', extra: object) => (dir: string) => ({
      BASE_URL: origin,
      CFG: JSON.stringify({ ...baseCfg, mode, ...extra }),
      SECRETS_FILE: join(dir, 'secrets.json'),
      DATA_FILE: join(dir, 'dataset.json'),
      BLOCKED: JSON.stringify(target.allowPrivateNetwork ? METADATA_CIDRS : [...PRIVATE_CIDRS, ...METADATA_CIDRS]),
    });

    // ---------------- Phase 1: the load itself ----------------
    const settleFrom = (s: Stage) => (cfg.profile === 'ramp' ? s.durationSec / 2 : s.rampSec);
    const tally = new Tally(loadStages, settleFrom);
    const peakPoints: number[] = [];
    const phaseAt = (sec: number): Phase => loadStages[tally.stageIndex(tally.rel(sec))]?.phase ?? 'peak';
    const collector = new MetricsCollector(
      run.id,
      (sec) => ({ bots: loadStages[tally.stageIndex(tally.rel(sec))]?.bots, phase: phaseAt(sec) }),
      (p: MetricPointDTO) => { if (p.phase === 'peak' && p.requests > 0) peakPoints.push(p.p95); },
    );
    const completedLevels = new Set<number>();
    let breaking: BreakingPoint | null = null;
    const levelsSoFar = () => [...completedLevels].sort((a, b) => a - b).map((i) => tally.levelStats(i));
    const recentRates: number[] = [];
    let lastTotal = 0;
    let hardStop = false; // budget or rate-ceiling breaches: do not send any more traffic, not even for the recovery check

    // Hybrid: a few real-browser bots run the same journeys while the protocol bots push the backend.
    const botsHandle = cfg.engine === 'hybrid' && cfg.browserBots > 0
      ? startBrowserBots({ runId: run.id, target, journeys, count: cfg.browserBots, maxRps: target.stressMaxRps, secrets, rows: cfg.dataset ? JSON.parse(loadDataset(datasetsDir, cfg.dataset)) : [] })
      : null;
    const bots: { result: BrowserBotResult | null } = { result: null };
    const stopBrowserBots = async () => { bots.result ??= (await botsHandle?.stop()) ?? null; };

    const stats = target.containerName && target.allowPrivateNetwork ? startDockerStats(target.containerName) : null;

    const load = await runK6({
      run, workDir, script: buildStressScript(),
      env: scriptEnv('load', {}),
      startMessage: `Stress test started: ${plan.stages.map((s) => s.bots).join(' → ')} bots`,
      auditData: { hypothesis: cfg.hypothesis, profile: cfg.profile, stages: loadStages, gapMs: plan.gapMs, estimatedRequests: plan.estimatedRequests },
      onRecord: (r) => { tally.record(r); collector.ingest(r); },
      onTick: async () => {
        await collector.flush();
        // Which scheduled levels are fully done (with a 2s lag for late samples)?
        if (cfg.profile !== 'quick' && tally.t0 !== null) {
          const nowRel = Math.floor(Date.now() / 1000) - tally.t0 - 2;
          tally.bounds.forEach((b, i) => { if (b.end <= nowRel) completedLevels.add(i); });
          const cur = tally.stageIndex(nowRel + 2);
          const curStart = tally.bounds[cur]!.start;
          const partial = !completedLevels.has(cur) && nowRel + 2 - curStart >= settleFrom(loadStages[cur]!) + 3 ? [tally.levelStats(cur)] : [];
          breaking = detectBreakingPoint([...levelsSoFar(), ...partial]);
          if (breaking && cfg.stopAtBreakingPoint) return { complete: `Breaking point found: ${breaking.reason}. Stopped adding bots.` };
        }
        const ws = collector.windowStats();
        const stop = evaluateStopRules(ws, cfg.stopRules);
        if (stop) return stop;
        if (collector.total > target.stressMaxRequests) return (hardStop = true, `Stress request budget of ${target.stressMaxRequests} exceeded`);
        recentRates.push(collector.total - lastTotal);
        lastTotal = collector.total;
        if (recentRates.length > 5) recentRates.shift();
        const avg = recentRates.reduce((a, b) => a + b, 0) / recentRates.length;
        if (recentRates.length === 5 && avg > target.stressMaxRps * 1.5) return (hardStop = true, `Observed rate ${avg.toFixed(0)} req/s exceeded the ${target.stressMaxRps} req/s ceiling`);
        return null;
      },
    });
    await collector.flush(true);
    await stopBrowserBots();
    const resources = (await stats?.stop()) ?? null;
    const failure = engineError(load);
    if (failure) throw new Error(redact(failure.message));

    // ---------------- Phase 2: recovery and data-integrity checks ----------------
    let recovery: Recovery | null = null;
    let integrity: StressSummary['integrity'] = null;
    const wantRecovery = !!recoveryStage && load.outcome !== 'CANCELLED';
    if (load.outcome !== 'CANCELLED' && !hardStop && (wantRecovery || hasVerify)) {
      const tailStages: Stage[] = wantRecovery ? [recoveryStage!] : [];
      const tail = new Tally(tailStages.length ? tailStages : [{ phase: 'recovery', bots: 1, rampSec: 0, durationSec: 1 }], () => 0);
      const windows = new Map<number, { d: number[]; f: number }>();
      const tailCollector = new MetricsCollector(run.id, () => ({ bots: recoveryStage?.bots ?? 0, phase: 'recovery' as Phase }));
      const tailRes = await runK6({
        run, workDir, script: buildStressScript(),
        env: scriptEnv('tail', { recoveryBots: wantRecovery ? recoveryStage!.bots : 0, recoverySec: recoveryStage?.durationSec ?? 0 }),
        startMessage: wantRecovery ? `Load dropped to ${recoveryStage!.bots} bot(s); measuring recovery for ${recoveryStage!.durationSec}s` : 'Running data-integrity checks',
        auditData: { phase: 'recovery' },
        onRecord: (r) => {
          tail.record(r); tailCollector.ingest(r);
          if (r.metric === 'http_req_duration' && r.tags.kind !== 'verify') {
            const w = Math.floor(tail.rel(r.sec) / 5) * 5;
            const e = windows.get(w) ?? { d: [], f: 0 };
            e.d.push(r.value);
            if (r.tags.expected_response !== 'true') e.f++;
            windows.set(w, e);
          }
        },
        onTick: async () => { await tailCollector.flush(); return null; },
      });
      await tailCollector.flush(true);
      const tailFailure = engineError(tailRes);
      if (tailFailure) throw new Error(redact(tailFailure.message));
      if (hasVerify) integrity = tail.integrity;
      if (wantRecovery) {
        const usable = tally.levels.map((_, i) => tally.levelStats(i)).filter((l) => l.requests >= 20);
        const baseline = usable[0];
        const points = [...windows.entries()].sort((a, b) => a[0] - b[0]).map(([t, w]) => {
          const sorted = [...w.d].sort((a, b) => a - b);
          return { t, p95: percentile(sorted, 95), errorRate: sorted.length ? w.f / sorted.length : 0, requests: sorted.length };
        });
        if (baseline && points.length) recovery = evaluateRecovery(points, baseline.p95);
      }
    }

    // ---------------- Summary ----------------
    const levels = tally.levels.map((_, i) => tally.levelStats(i)).filter((l) => l.requests > 0);
    const finalBreaking = detectBreakingPoint(levels);
    const steps = tally.stepStats();
    const peakRps = levels.reduce((m, l) => Math.max(m, l.rps), 0);
    const errorRate = collector.total ? collector.failed / collector.total : 0;
    const cacheTotal = tally.cacheHit + tally.cacheMiss;
    const summary: StressSummary = {
      totalRequests: collector.total,
      failedRequests: collector.failed,
      errorRate,
      peakBots: plan.peakBots,
      peakRps: Math.max(peakRps, collector.peakRps),
      durationSec: collector.elapsedSec(),
      levels,
      breakingPoint: finalBreaking,
      steps,
      statusCounts: tally.statusCounts,
      errorKinds: tally.errorKinds,
      cacheHitRatio: cacheTotal > 0 ? tally.cacheHit / cacheTotal : null,
      wafBlocks: tally.waf,
      health: healthVerdicts(levels, finalBreaking, errorRate),
      patterns: classifyFailurePattern(levels, steps, finalBreaking),
      recovery,
      integrity,
      vitals: bots.result?.vitals ?? null,
      browser: bots.result?.browser ?? null,
      resources,
      driftPct: cfg.profile === 'soak' ? latencyDrift(peakPoints) : null,
      ceilingReached: levels.some((l) => l.rps >= plan.maxPossibleRps * 0.9),
      hypothesis: cfg.hypothesis,
      abortReason: load.abortReason,
    };
    await saveFindings(run, bottleneckFindings(summary, target.baseUrl));
    await audit(run.id, 'stress-summary', finalBreaking ? `Breaking point at ${finalBreaking.bots} bots: ${finalBreaking.reason}` : 'No breaking point found at the tested load',
      { breakingPoint: finalBreaking, recovery, hypothesis: cfg.hypothesis } as never);
    // A safety stop that happened because the site broke is the answer this test was looking for, not a failure of the test.
    const foundIt = load.outcome === 'ABORTED' && !hardStop && !!finalBreaking;
    return { status: foundIt ? 'COMPLETED' : load.outcome, summary: summary as never, error: !foundIt && load.abortReason ? redact(load.abortReason) : undefined };
  } catch (err) {
    throw new Error(redact(errMessage(err)));
  } finally {
    removeDir(workDir);
  }
}
