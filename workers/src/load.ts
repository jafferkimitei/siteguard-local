import { LoadConfig, type LoadSummary } from '@siteguard/contracts';
import { assertDestinationAllowed, evaluateStopRules, percentile, validateLoadPlan } from '@siteguard/safety';
import type { RunnerResult, RunWithTarget } from './common';
import { METADATA_CIDRS, MetricsCollector, PRIVATE_CIDRS, engineError, runK6 } from './k6run';
import { makeWorkDir, removeDir } from './proc';

export function buildK6Script(): string {
  return `import http from 'k6/http';

const BASE = __ENV.BASE_URL.replace(/\\/$/, '');
const PATHS = JSON.parse(__ENV.PATHS);
const STAGES = JSON.parse(__ENV.STAGES);
const BLOCKED = JSON.parse(__ENV.BLOCKED);

export const options = {
  discardResponseBodies: true,
  // Never follow redirects: they could leave the approved scope. 3xx counts as a normal response.
  maxRedirects: 0,
  blacklistIPs: BLOCKED,
  userAgent: 'SiteGuardLocal/0.1 (own-site load test)',
  scenarios: {
    load: {
      executor: 'ramping-arrival-rate',
      startRate: Number(__ENV.START_RATE),
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.MAX_VUS),
      maxVUs: Number(__ENV.MAX_VUS),
      stages: STAGES,
    },
  },
};

export default function () {
  const path = PATHS[Math.floor(Math.random() * PATHS.length)];
  http.get(BASE + path, { responseCallback: http.expectedStatuses({ min: 200, max: 399 }) });
}
`;
}

export function buildStages(rps: number, durationSec: number, rampUpSec: number) {
  const stages: { duration: string; target: number }[] = [];
  if (rampUpSec > 0) stages.push({ duration: `${rampUpSec}s`, target: rps });
  if (durationSec - rampUpSec > 0) stages.push({ duration: `${durationSec - rampUpSec}s`, target: rps });
  return stages;
}

export async function runLoad(run: RunWithTarget): Promise<RunnerResult> {
  const { target } = run;
  const cfg = LoadConfig.parse(run.config);
  const plan = validateLoadPlan(cfg, target); // re-check: the config could have been edited in the DB

  const urls = cfg.paths.map((p) => new URL(p, target.baseUrl).toString());
  for (const u of new Set(urls)) await assertDestinationAllowed(u, target);

  const workDir = makeWorkDir(run.id);
  const origin = new URL(target.baseUrl).origin;
  const collector = new MetricsCollector(run.id);
  const result = await runK6({
    run,
    workDir,
    script: buildK6Script(),
    env: () => ({
      BASE_URL: origin,
      PATHS: JSON.stringify(cfg.paths),
      STAGES: JSON.stringify(buildStages(cfg.rps, cfg.durationSec, cfg.rampUpSec)),
      START_RATE: String(cfg.rampUpSec > 0 ? 0 : cfg.rps),
      MAX_VUS: String(cfg.maxVus),
      BLOCKED: JSON.stringify(target.allowPrivateNetwork ? METADATA_CIDRS : [...PRIVATE_CIDRS, ...METADATA_CIDRS]),
    }),
    startMessage: `k6 started: up to ${cfg.rps} req/s for ${cfg.durationSec}s`,
    auditData: { ...plan },
    onRecord: (r) => collector.ingest(r),
    onTick: async () => {
      await collector.flush();
      return evaluateStopRules(collector.windowStats(), cfg.stopRules) ??
        (collector.total > target.maxRequests ? `Request budget of ${target.maxRequests} exceeded` : null);
    },
  });
  await collector.flush(true);

  const failure = engineError(result);
  if (failure) {
    removeDir(workDir);
    throw failure;
  }

  const sorted = [...collector.allDurations].sort((a, b) => a - b);
  const { total, failed } = collector;
  const elapsed = collector.elapsedSec();
  const sum = sorted.reduce((a, b) => a + b, 0);
  const summary: LoadSummary = {
    totalRequests: total,
    failedRequests: failed,
    errorRate: total ? failed / total : 0,
    avgRps: elapsed ? total / elapsed : 0,
    peakRps: collector.peakRps,
    avgMs: total ? sum / total : 0,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    statusCounts: collector.statusCounts,
    durationSec: elapsed,
    abortReason: result.abortReason,
  };
  removeDir(workDir);
  return { status: result.outcome, summary: summary as never, error: result.abortReason };
}
