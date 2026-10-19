import { z } from 'zod';
import { HARD_MAX_BROWSER_BOTS, HARD_MAX_STRESS_BOTS, StopRules } from './limits';

// =====================================================================================
// Journeys: ordered HTTP steps that share cookies and extracted values, like a real user.
// =====================================================================================

export const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const VarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits and underscores');

export const StepExtract = z.object({
  var: VarName,
  from: z.enum(['json', 'header', 'regex']),
  /** json: dotted path (cart.id); header: header name; regex: pattern with one capture group. */
  expr: z.string().min(1).max(300),
});

export const StepCheck = z.object({
  status: z.number().int().min(100).max(599).optional(),
  bodyIncludes: z.string().max(300).optional(),
  /** Two top-level JSON fields that must hold the same value (e.g. orders === unique). */
  equalFields: z.tuple([z.string().max(100), z.string().max(100)]).optional(),
});

export const JourneyStep = z.object({
  name: z.string().trim().min(1).max(60),
  method: HttpMethod.default('GET'),
  /** Relative path. May contain {{var}}, {{env.SG_NAME}} and {{data.field}}. */
  path: z.string().startsWith('/').max(500),
  headers: z.record(z.string().max(100), z.string().max(1000)).default({}),
  bodyType: z.enum(['none', 'json', 'form']).default('none'),
  body: z.string().max(5000).default(''),
  extract: z.array(StepExtract).max(10).default([]),
  checks: z.array(StepCheck).max(10).default([]),
  thinkMs: z.number().int().min(0).max(30_000).default(1000),
  /** verify steps run once after the load and test data integrity (they are read-only by convention). */
  kind: z.enum(['normal', 'verify']).default('normal'),
});
export type JourneyStep = z.infer<typeof JourneyStep>;

export const JourneyInput = z.object({
  name: z.string().trim().min(1).max(80),
  steps: z.array(JourneyStep).min(1).max(30),
});
export type JourneyInput = z.infer<typeof JourneyInput>;

const TOKEN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

/** Every {{reference}} found in a string. */
export function templateRefs(s: string): string[] {
  return [...s.matchAll(TOKEN)].map((m) => m[1]!);
}

/** All references across a step (path, headers, body). */
export function stepRefs(step: JourneyStep): string[] {
  return [step.path, step.body, ...Object.values(step.headers), ...step.checks.flatMap((c) => c.bodyIncludes ?? [])].flatMap(templateRefs);
}

export const ENV_REF = /^env\.(SG_[A-Z0-9_]+)$/;
export const DATA_REF = /^data\.([A-Za-z0-9_]+)$/;

const PAYMENT_HINT = /(pay(ment)?|charge|refund|stripe|paypal|mpesa|paystack|card)/i;
/** Non-blocking advice about steps that could touch third parties or real money. */
export function journeyWarnings(j: JourneyInput): string[] {
  const out: string[] = [];
  for (const s of j.steps)
    if (PAYMENT_HINT.test(s.path) || PAYMENT_HINT.test(s.name))
      out.push(`Step "${s.name}" looks payment-related. Payment providers enforce their own lower rate limits and real charges can occur; point this step at a sandbox or mock endpoint.`);
  return out;
}

// =====================================================================================
// Stress configuration and the bot schedule ("bots multiplying per interval")
// =====================================================================================

export const StressProfile = z.enum(['quick', 'ramp', 'step', 'spike', 'soak']);
export type StressProfile = z.infer<typeof StressProfile>;

export const MixEntry = z.object({
  journeyId: z.string().min(1).optional(),
  /** Simple GET paths when no journey is chosen. */
  paths: z.array(z.string().startsWith('/')).min(1).max(50).optional(),
  weight: z.number().int().min(1).max(100).default(1),
}).refine((m) => m.journeyId || m.paths, 'Pick a journey or at least one path');
export type MixEntry = z.infer<typeof MixEntry>;

export const StressConfig = z.object({
  hypothesis: z.string().trim().min(5, 'Write what you expect to happen').max(500),
  profile: StressProfile.default('step'),
  engine: z.enum(['protocol', 'hybrid']).default('protocol'),
  /** Real-browser bots run alongside protocol bots when engine is hybrid. */
  browserBots: z.number().int().min(0).max(HARD_MAX_BROWSER_BOTS).default(3),
  mix: z.array(MixEntry).min(1).max(10),
  startBots: z.number().int().min(1).max(HARD_MAX_STRESS_BOTS).default(2),
  growth: z.object({
    mode: z.enum(['add', 'multiply']).default('multiply'),
    amount: z.number().int().min(1).max(HARD_MAX_STRESS_BOTS).default(5),
    factor: z.number().min(1.1).max(10).default(2),
  }).default({ mode: 'multiply', amount: 5, factor: 2 }),
  intervalSec: z.number().int().min(5).max(600).default(30),
  maxBots: z.number().int().min(1).max(HARD_MAX_STRESS_BOTS).default(32),
  /** spike: how long the burst lasts. soak: how long to hold maxBots. */
  holdSec: z.number().int().min(5).max(3600).default(60),
  /** quick (ApacheBench style: ab -n requests -c concurrency). */
  requests: z.number().int().min(10).max(100_000).default(1000),
  concurrency: z.number().int().min(1).max(HARD_MAX_STRESS_BOTS).default(10),
  recovery: z.object({
    enabled: z.boolean().default(true),
    holdSec: z.number().int().min(10).max(600).default(60),
    bots: z.number().int().min(1).max(HARD_MAX_STRESS_BOTS).default(1),
  }).default({ enabled: true, holdSec: 60, bots: 1 }),
  /** File name inside datasets/ (json array or csv with a header row). */
  dataset: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
  stopRules: StopRules.default({ maxErrorRate: 0.5, maxP95Ms: 10_000 }),
  /** Finish the ramp when the breaking point is found instead of continuing to pile on. */
  stopAtBreakingPoint: z.boolean().default(true),
});
export type StressConfig = z.infer<typeof StressConfig>;

export type Phase = 'ramp' | 'peak' | 'recovery';

export interface Stage {
  phase: Phase;
  /** Bots at the end of the ramp part of this stage. */
  bots: number;
  /** Seconds spent ramping linearly to `bots` from the previous stage's level. */
  rampSec: number;
  /** Total length of the stage including the ramp. */
  durationSec: number;
}

const SPIKE_RAMP_SEC = 5;
const STEP_RAMP_SEC = (interval: number) => Math.min(5, Math.max(1, Math.round(interval / 5)));

/** Bot counts per interval: add a fixed amount, or multiply by a factor, capped at maxBots. */
export function botLevels(cfg: Pick<StressConfig, 'startBots' | 'growth' | 'maxBots'>): number[] {
  const levels: number[] = [Math.min(cfg.startBots, cfg.maxBots)];
  while (levels[levels.length - 1]! < cfg.maxBots && levels.length < 200) {
    const prev = levels[levels.length - 1]!;
    const next = cfg.growth.mode === 'add' ? prev + cfg.growth.amount : Math.max(prev + 1, Math.round(prev * cfg.growth.factor));
    levels.push(Math.min(next, cfg.maxBots));
  }
  return levels;
}

/** The full timeline of bot counts, in order. Pure so the dashboard can preview it. */
export function botSchedule(cfg: StressConfig): Stage[] {
  const stages: Stage[] = [];
  const levels = botLevels(cfg);
  if (cfg.profile === 'quick') {
    stages.push({ phase: 'peak', bots: cfg.concurrency, rampSec: 0, durationSec: 0 });
    return stages; // duration is decided by the request count, not the clock
  }
  if (cfg.profile === 'ramp' || cfg.profile === 'step') {
    levels.forEach((bots, i) => {
      const rampSec = cfg.profile === 'ramp' ? cfg.intervalSec : i === 0 ? 0 : STEP_RAMP_SEC(cfg.intervalSec);
      stages.push({ phase: i === levels.length - 1 ? 'peak' : 'ramp', bots, rampSec, durationSec: cfg.intervalSec });
    });
  } else if (cfg.profile === 'spike') {
    stages.push({ phase: 'ramp', bots: Math.min(cfg.startBots, cfg.maxBots), rampSec: 0, durationSec: cfg.intervalSec });
    stages.push({ phase: 'peak', bots: cfg.maxBots, rampSec: SPIKE_RAMP_SEC, durationSec: cfg.holdSec });
    stages.push({ phase: 'ramp', bots: Math.min(cfg.startBots, cfg.maxBots), rampSec: SPIKE_RAMP_SEC, durationSec: cfg.intervalSec });
  } else {
    // soak: one ramp interval, then hold at maxBots
    stages.push({ phase: 'ramp', bots: cfg.maxBots, rampSec: cfg.intervalSec, durationSec: cfg.intervalSec });
    stages.push({ phase: 'peak', bots: cfg.maxBots, rampSec: 0, durationSec: cfg.holdSec });
  }
  if (cfg.recovery.enabled)
    stages.push({ phase: 'recovery', bots: Math.min(cfg.recovery.bots, cfg.maxBots), rampSec: SPIKE_RAMP_SEC, durationSec: cfg.recovery.holdSec });
  return stages;
}

export interface ScheduleStats {
  durationSec: number;
  peakBots: number;
  /** Sum over time of bots (bot-seconds), assuming linear ramps. */
  botSeconds: number;
}

export function scheduleStats(stages: Stage[]): ScheduleStats {
  let prev = 0;
  let botSeconds = 0;
  let durationSec = 0;
  let peakBots = 0;
  for (const s of stages) {
    const ramp = Math.min(s.rampSec, s.durationSec);
    botSeconds += ((prev + s.bots) / 2) * ramp + s.bots * (s.durationSec - ramp);
    durationSec += s.durationSec;
    peakBots = Math.max(peakBots, s.bots);
    prev = s.bots;
  }
  return { durationSec, peakBots, botSeconds };
}

/**
 * Minimum pause after every request so the plan cannot exceed the target's req/s ceiling by
 * construction: peakBots * (1000 / gap) <= maxRps.
 */
export function minGapMs(peakBots: number, maxRps: number): number {
  return Math.max(0, Math.ceil((1000 * peakBots) / Math.max(1, maxRps)));
}

/** Upper bound on requests the schedule can produce given the pacing gap. */
export function estimateStressRequests(cfg: StressConfig, maxRps: number): number {
  if (cfg.profile === 'quick') return cfg.requests;
  const stages = botSchedule(cfg);
  const { peakBots, botSeconds } = scheduleStats(stages);
  const gap = Math.max(minGapMs(peakBots, maxRps), 1);
  return Math.ceil((botSeconds * 1000) / gap);
}

// =====================================================================================
// What a failing website looks like
// =====================================================================================

export const STATUS_MEANINGS: Record<string, { meaning: string; cause: string }> = {
  '0': { meaning: 'No response (connection refused, reset or timed out)', cause: 'The server stopped accepting connections: worker/thread pool or connection table exhausted, or the process crashed.' },
  '400': { meaning: 'Bad request', cause: 'The request was malformed, often because a value extracted from an earlier step was missing.' },
  '401': { meaning: 'Unauthorised', cause: 'Login failed or the session expired or was evicted under load.' },
  '403': { meaning: 'Forbidden', cause: 'A WAF or bot protection may be blocking the test traffic, or a CSRF token was rejected.' },
  '404': { meaning: 'Not found', cause: 'The path is wrong, or data created earlier in the journey was lost.' },
  '408': { meaning: 'Request timeout', cause: 'The server gave up waiting for the client.' },
  '429': { meaning: 'Too many requests', cause: 'A rate limiter is rejecting traffic (good: it is protecting the app, but it also caps what you can measure).' },
  '500': { meaning: 'Internal server error', cause: 'The application threw an exception; under load this is often a database or dependency failure.' },
  '502': { meaning: 'Bad gateway', cause: 'A proxy or load balancer got an invalid response, or the app process behind it died or restarted.' },
  '503': { meaning: 'Service unavailable', cause: 'The server is overloaded and cannot take the request right now (queue full, no free workers).' },
  '504': { meaning: 'Gateway timeout', cause: 'One part of your stack waited too long for another (proxy for app, or app for database) and gave up.' },
};

export const statusMeaning = (code: string | number) => {
  const c = String(code);
  return STATUS_MEANINGS[c] ?? (c.startsWith('5') ? { meaning: 'Server error', cause: 'The server failed to handle the request.' }
    : c.startsWith('4') ? { meaning: 'Client error', cause: 'The server rejected the request.' } : { meaning: 'OK', cause: '' });
};

export const HEALTH_THRESHOLDS = {
  /** Error rate at or under this is healthy. */
  errorRateOk: 0.01,
  /** Over this is a clear failure. */
  errorRateBad: 0.05,
  /** p95 may grow this much over the baseline before it counts as degrading. */
  latencyDegrading: 1.5,
  latencySpiking: 3,
  /** Latency growth below this many ms is ignored (tiny baselines). */
  latencyFloorMs: 100,
  /** Throughput at the end below this share of its best is a collapse. */
  throughputCollapse: 0.7,
} as const;

/** Aggregated numbers for one bot level (one interval). */
export interface LevelStats {
  bots: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  requests: number;
}

export interface BreakingPoint {
  levelIndex: number;
  bots: number;
  rps: number;
  kind: 'errors' | 'latency' | 'plateau';
  reason: string;
}

const MIN_LEVEL_REQUESTS = 20;

/** First level where the site clearly stops coping, relative to the first healthy level. */
export function detectBreakingPoint(levels: LevelStats[]): BreakingPoint | null {
  const usable = levels.map((l, i) => ({ l, i })).filter(({ l }) => l.requests >= MIN_LEVEL_REQUESTS);
  if (usable.length < 2) return null;
  const base = usable[0]!.l;
  for (let k = 1; k < usable.length; k++) {
    const { l, i } = usable[k]!;
    const prev = usable[k - 1]!.l;
    const mk = (kind: BreakingPoint['kind'], reason: string): BreakingPoint => ({ levelIndex: i, bots: l.bots, rps: l.rps, kind, reason });
    if (l.errorRate > HEALTH_THRESHOLDS.errorRateBad)
      return mk('errors', `Error rate reached ${(l.errorRate * 100).toFixed(1)}% at ${l.bots} bots`);
    if (l.p95 > base.p95 * HEALTH_THRESHOLDS.latencySpiking && l.p95 - base.p95 > HEALTH_THRESHOLDS.latencyFloorMs)
      return mk('latency', `p95 rose from ${Math.round(base.p95)} ms to ${Math.round(l.p95)} ms at ${l.bots} bots`);
    if (l.bots >= prev.bots * 1.2 && l.rps < prev.rps * 1.05 && l.p95 > prev.p95 * 1.3 && l.p95 - prev.p95 > HEALTH_THRESHOLDS.latencyFloorMs)
      return mk('plateau', `Throughput stopped rising (${prev.rps.toFixed(1)} to ${l.rps.toFixed(1)} req/s) while bots grew from ${prev.bots} to ${l.bots} and latency climbed`);
  }
  return null;
}

export interface StepStats {
  journey: string;
  step: string;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  statusCounts: Record<string, number>;
}

export interface FailurePattern {
  pattern: 'hockey-stick' | 'errors-first' | 'partial-failure' | 'gradual';
  message: string;
}

/** Name the shape of the failure using the per-level curve and per-step stats. */
export function classifyFailurePattern(levels: LevelStats[], steps: StepStats[], bp: BreakingPoint | null): FailurePattern[] {
  const out: FailurePattern[] = [];
  const usable = levels.filter((l) => l.requests >= MIN_LEVEL_REQUESTS);
  const failing = steps.filter((s) => s.requests >= MIN_LEVEL_REQUESTS && s.errorRate > HEALTH_THRESHOLDS.errorRateBad);
  const healthy = steps.filter((s) => s.requests >= MIN_LEVEL_REQUESTS && s.errorRate <= HEALTH_THRESHOLDS.errorRateOk);
  if (failing.length > 0 && healthy.length > 0)
    out.push({ pattern: 'partial-failure', message: `Some steps fail while others stay healthy: ${failing.map((s) => `"${s.step}" (${(s.errorRate * 100).toFixed(0)}% errors)`).join(', ')}. A single dependency behind those steps (database table, payment or search service) is the likely bottleneck.` });
  if (!bp || usable.length < 2) return out;
  const base = usable[0]!;
  const at = usable.findIndex((l) => l.bots === bp.bots);
  if (bp.kind === 'errors' && at > 0 && usable[at]!.p95 < base.p95 * HEALTH_THRESHOLDS.latencyDegrading)
    out.push({ pattern: 'errors-first', message: 'Errors appeared before response times degraded. That usually means aggressive rate limiting, a fail-fast circuit breaker or a queue that overflows instead of waiting.' });
  else if (at > 0) {
    const before = usable.slice(0, at);
    const steady = before.every((l) => l.p95 < base.p95 * HEALTH_THRESHOLDS.latencyDegrading + HEALTH_THRESHOLDS.latencyFloorMs);
    if (steady && usable[at]!.p95 > base.p95 * HEALTH_THRESHOLDS.latencySpiking)
      out.push({ pattern: 'hockey-stick', message: `Response times stayed flat up to ${before[before.length - 1]!.bots} bots, then jumped at ${bp.bots}. That is the signature of a saturated resource: database connection pool, web-server threads, CPU or memory.` });
    else out.push({ pattern: 'gradual', message: 'Latency climbed steadily as bots increased, with no single sharp threshold. Look for work that scales with load (queries without an index, growing caches).' });
  }
  return out;
}

export interface RecoveryPoint {
  /** Seconds since the recovery phase began. */
  t: number;
  p95: number;
  errorRate: number;
  requests: number;
}
export interface Recovery {
  recovered: boolean;
  secondsToBaseline: number | null;
  residualErrorRate: number;
  residualP95: number;
}

/** Recovered = 3 consecutive recovery points back near baseline latency with (almost) no errors. */
export function evaluateRecovery(points: RecoveryPoint[], baselineP95: number): Recovery {
  const limit = baselineP95 * HEALTH_THRESHOLDS.latencyDegrading + HEALTH_THRESHOLDS.latencyFloorMs / 2;
  const ok = (p: RecoveryPoint) => p.requests > 0 && p.p95 <= limit && p.errorRate <= HEALTH_THRESHOLDS.errorRateOk;
  let secondsToBaseline: number | null = null;
  for (let i = 0; i + 2 < points.length; i++) {
    if (ok(points[i]!) && ok(points[i + 1]!) && ok(points[i + 2]!)) { secondsToBaseline = points[i]!.t; break; }
  }
  const tail = points.slice(-5).filter((p) => p.requests > 0);
  const avg = (f: (p: RecoveryPoint) => number) => (tail.length ? tail.reduce((a, p) => a + f(p), 0) / tail.length : 0);
  return { recovered: secondsToBaseline !== null, secondsToBaseline, residualErrorRate: avg((p) => p.errorRate), residualP95: avg((p) => p.p95) };
}

/** Relative p95 growth over a soak: last quarter vs first quarter of the held period. */
export function latencyDrift(p95s: number[]): number {
  if (p95s.length < 8) return 0;
  const q = Math.floor(p95s.length / 4);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const first = mean(p95s.slice(0, q));
  const last = mean(p95s.slice(-q));
  return first > 0 ? last / first - 1 : 0;
}

export type Verdict = 'ok' | 'warn' | 'bad';
export interface HealthVerdict { id: 'response' | 'errors' | 'throughput'; verdict: Verdict; text: string }

export function healthVerdicts(levels: LevelStats[], bp: BreakingPoint | null, overallErrorRate: number): HealthVerdict[] {
  const usable = levels.filter((l) => l.requests >= MIN_LEVEL_REQUESTS);
  const base = usable[0];
  const worst = usable.reduce((m, l) => Math.max(m, l.p95), 0);
  const response: HealthVerdict = !base ? { id: 'response', verdict: 'warn', text: 'Not enough requests to judge response time.' }
    : bp?.kind === 'latency' || worst > base.p95 * HEALTH_THRESHOLDS.latencySpiking && worst - base.p95 > HEALTH_THRESHOLDS.latencyFloorMs
      ? { id: 'response', verdict: 'bad', text: `Response time spiked from ${Math.round(base.p95)} ms to ${Math.round(worst)} ms (p95) as users increased.` }
      : worst > base.p95 * HEALTH_THRESHOLDS.latencyDegrading && worst - base.p95 > HEALTH_THRESHOLDS.latencyFloorMs
        ? { id: 'response', verdict: 'warn', text: `Response time grew from ${Math.round(base.p95)} ms to ${Math.round(worst)} ms (p95).` }
        : { id: 'response', verdict: 'ok', text: 'Response time stayed steady as users increased.' };
  const errors: HealthVerdict = overallErrorRate <= HEALTH_THRESHOLDS.errorRateOk ? { id: 'errors', verdict: 'ok', text: `Error rate ${(overallErrorRate * 100).toFixed(2)}% (healthy is under 1%).` }
    : overallErrorRate <= HEALTH_THRESHOLDS.errorRateBad ? { id: 'errors', verdict: 'warn', text: `Error rate ${(overallErrorRate * 100).toFixed(2)}% is above the 1% healthy level.` }
      : { id: 'errors', verdict: 'bad', text: `Error rate ${(overallErrorRate * 100).toFixed(1)}% is far above the 1% healthy level.` };
  const best = usable.reduce((m, l) => Math.max(m, l.rps), 0);
  const last = usable[usable.length - 1];
  const throughput: HealthVerdict = !last ? { id: 'throughput', verdict: 'warn', text: 'Not enough data to judge throughput.' }
    : bp?.kind === 'plateau' || last.rps < best * HEALTH_THRESHOLDS.throughputCollapse
      ? { id: 'throughput', verdict: last.rps < best * HEALTH_THRESHOLDS.throughputCollapse ? 'bad' : 'warn',
          text: last.rps < best * HEALTH_THRESHOLDS.throughputCollapse ? `Throughput collapsed from ${best.toFixed(1)} to ${last.rps.toFixed(1)} req/s at the highest load.` : 'Throughput levelled off abruptly instead of smoothly.' }
      : { id: 'throughput', verdict: 'ok', text: 'Throughput kept rising with users, then levelled off smoothly.' };
  return [response, errors, throughput];
}

export interface StressSummary {
  totalRequests: number;
  failedRequests: number;
  errorRate: number;
  peakBots: number;
  peakRps: number;
  durationSec: number;
  levels: LevelStats[];
  breakingPoint: BreakingPoint | null;
  steps: StepStats[];
  statusCounts: Record<string, number>;
  cacheHitRatio: number | null;
  wafBlocks: number;
  health: HealthVerdict[];
  patterns: FailurePattern[];
  recovery: Recovery | null;
  integrity: { checks: number; failures: number } | null;
  vitals: { sessions: number; ttfb: number; fcp: number; lcp: number; cls: number } | null;
  driftPct: number | null;
  ceilingReached: boolean;
  hypothesis: string;
  abortReason?: string;
}
