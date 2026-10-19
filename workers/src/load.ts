import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, openSync, readSync, writeFileSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { LoadConfig, type LoadSummary, type MetricPointDTO } from '@siteguard/contracts';
import { env, prisma } from '@siteguard/database';
import { assertDestinationAllowed, evaluateStopRules, percentile, validateLoadPlan } from '@siteguard/safety';
import { audit, isCancelled, progress, publish, sleep, type RunnerResult, type RunWithTarget } from './common';
import { killContainer, makeWorkDir, removeDir, watchChild } from './proc';

const PRIVATE_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'];
const METADATA_CIDRS = ['169.254.0.0/16'];

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

function hasLocalK6() {
  return spawnSync('k6', ['version'], { stdio: 'ignore' }).status === 0;
}

/** Incrementally reads new complete lines appended to a file. */
class Tailer {
  private fd: number | null = null;
  private offset = 0;
  private carry = '';
  constructor(private path: string) {}
  read(): string[] {
    if (this.fd === null) {
      try {
        this.fd = openSync(this.path, 'r');
      } catch {
        return [];
      }
    }
    const size = fstatSync(this.fd).size;
    if (size <= this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    readSync(this.fd, buf, 0, buf.length, this.offset);
    this.offset = size;
    const text = this.carry + buf.toString('utf8');
    const lines = text.split('\n');
    this.carry = lines.pop() ?? '';
    return lines.filter(Boolean);
  }
  close() {
    if (this.fd !== null) closeSync(this.fd);
  }
}

interface Bucket {
  durations: number[];
  failed: number;
  vus: number;
}

export async function runLoad(run: RunWithTarget): Promise<RunnerResult> {
  const { target } = run;
  const cfg = LoadConfig.parse(run.config);
  const plan = validateLoadPlan(cfg, target); // re-check: the config could have been edited in the DB

  const urls = cfg.paths.map((p) => new URL(p, target.baseUrl).toString());
  for (const u of new Set(urls)) await assertDestinationAllowed(u, target);

  const workDir = makeWorkDir(run.id);
  writeFileSync(join(workDir, 'script.js'), buildK6Script());
  const outFile = join(workDir, 'out.ndjson');
  writeFileSync(outFile, '');
  chmodSync(outFile, 0o666);

  const origin = new URL(target.baseUrl).origin;
  const k6Env: Record<string, string> = {
    BASE_URL: origin,
    PATHS: JSON.stringify(cfg.paths),
    STAGES: JSON.stringify(buildStages(cfg.rps, cfg.durationSec, cfg.rampUpSec)),
    START_RATE: String(cfg.rampUpSec > 0 ? 0 : cfg.rps),
    MAX_VUS: String(cfg.maxVus),
    BLOCKED: JSON.stringify(target.allowPrivateNetwork ? METADATA_CIDRS : [...PRIVATE_CIDRS, ...METADATA_CIDRS]),
  };

  const useLocal = env.K6_MODE === 'local' || (env.K6_MODE === 'auto' && hasLocalK6());
  const containerName = `sg-k6-${run.id}`;
  let child: ChildProcess;
  if (useLocal) {
    child = spawn('k6', ['run', '--quiet', '--no-usage-report', '--out', `json=${outFile}`, join(workDir, 'script.js')], {
      env: { ...process.env, ...k6Env },
    });
  } else {
    const uid = process.getuid?.() ?? 1000;
    const envArgs = Object.entries(k6Env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    child = spawn(
      'docker',
      ['run', '--rm', '--name', containerName, '--network', 'host', '--user', `${uid}`, ...envArgs, '-v', `${workDir}:/work`,
        env.K6_DOCKER_IMAGE, 'run', '--quiet', '--no-usage-report', '--out', 'json=/work/out.ndjson', '/work/script.js'],
    );
  }
  await audit(run.id, 'engine', `k6 started (${useLocal ? 'local binary' : 'docker ' + env.K6_DOCKER_IMAGE})`, { ...plan });
  await progress(run.id, `k6 started: up to ${cfg.rps} req/s for ${cfg.durationSec}s`);

  const proc = watchChild(child, 4000);
  const kill = () => {
    if (useLocal) child.kill('SIGTERM');
    else killContainer(containerName);
  };

  const tail = new Tailer(outFile);
  const buckets = new Map<number, Bucket>();
  const allDurations: number[] = [];
  const statusCounts: Record<string, number> = {};
  let total = 0;
  let failed = 0;
  let lastVus = 0;
  let peakRps = 0;
  let firstTs = Infinity;
  let lastTs = 0;
  let emittedUpTo = 0; // seconds (epoch) already emitted
  const pending: MetricPointDTO[] = [];
  let outcome: 'COMPLETED' | 'CANCELLED' | 'ABORTED' = 'COMPLETED';
  let abortReason: string | undefined;

  const bucketOf = (sec: number) => {
    let b = buckets.get(sec);
    if (!b) buckets.set(sec, (b = { durations: [], failed: 0, vus: lastVus }));
    return b;
  };

  const ingest = (line: string) => {
    let rec: { type: string; metric: string; data: { time: string; value: number; tags?: Record<string, string> } };
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    if (rec.type !== 'Point') return;
    const sec = Math.floor(new Date(rec.data.time).getTime() / 1000);
    if (rec.metric === 'vus') {
      lastVus = rec.data.value;
      bucketOf(sec).vus = rec.data.value;
    } else if (rec.metric === 'http_req_duration') {
      const status = rec.data.tags?.status ?? '0';
      const ok = rec.data.tags?.expected_response === 'true';
      const b = bucketOf(sec);
      b.durations.push(rec.data.value);
      if (!ok) b.failed++;
      allDurations.push(rec.data.value);
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      total++;
      if (!ok) failed++;
      firstTs = Math.min(firstTs, sec);
      lastTs = Math.max(lastTs, sec);
    }
  };

  const toPoint = (sec: number, b: Bucket): MetricPointDTO => {
    const sorted = [...b.durations].sort((a, c) => a - c);
    return {
      ts: new Date(sec * 1000).toISOString(),
      rps: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      errorRate: sorted.length ? b.failed / sorted.length : 0,
      vus: b.vus,
      requests: sorted.length,
    };
  };

  /** Emit every fully-elapsed second (leaving a 1s lag so late points still land in the right bucket). */
  const flush = async (final = false) => {
    const limit = final ? Infinity : Math.floor(Date.now() / 1000) - 1;
    const secs = [...buckets.keys()].filter((s) => s > emittedUpTo && s <= limit).sort((a, b) => a - b);
    for (const sec of secs) {
      const point = toPoint(sec, buckets.get(sec)!);
      peakRps = Math.max(peakRps, point.rps);
      emittedUpTo = sec;
      pending.push(point);
      await publish(run.id, { kind: 'metric', point });
    }
    if (pending.length >= 5 || (final && pending.length)) {
      const batch = pending.splice(0);
      await prisma.metricPoint.createMany({ data: batch.map((p) => ({ ...p, ts: new Date(p.ts), runId: run.id })) });
    }
    return secs.length;
  };

  const windowStats = () => {
    const recent = [...buckets.keys()].sort((a, b) => b - a).slice(0, 5);
    const ds: number[] = [];
    let f = 0;
    for (const s of recent) {
      const b = buckets.get(s)!;
      ds.push(...b.durations);
      f += b.failed;
    }
    ds.sort((a, b) => a - b);
    return { requests: ds.length, errorRate: ds.length ? f / ds.length : 0, p95: percentile(ds, 95) };
  };

  let lastCheck = 0;
  while (proc.exitCode() === null) {
    await sleep(250);
    for (const line of tail.read()) ingest(line);
    if (await isCancelled(run.id)) {
      outcome = 'CANCELLED';
      kill();
      break;
    }
    if (Date.now() - lastCheck >= 1000) {
      lastCheck = Date.now();
      await flush();
      const reason =
        evaluateStopRules(windowStats(), cfg.stopRules) ??
        (total > target.maxRequests ? `Request budget of ${target.maxRequests} exceeded` : null);
      if (reason) {
        outcome = 'ABORTED';
        abortReason = reason;
        kill();
        await audit(run.id, 'abort', reason);
        break;
      }
    }
  }
  // Give the process a moment to exit, then drain whatever it wrote last.
  for (let i = 0; i < 20 && proc.exitCode() === null; i++) await sleep(100);
  await sleep(200);
  for (const line of tail.read()) ingest(line);
  tail.close();
  await flush(true);

  const exitCode = proc.exitCode();
  if (outcome === 'COMPLETED' && exitCode !== 0 && exitCode !== 99) {
    // 99 = threshold failure in k6; we define none, so any non-zero exit is an engine error.
    removeDir(workDir);
    throw new Error(`k6 exited with code ${exitCode}: ${proc.stderr().trim().slice(-800) || 'no output'}`);
  }

  allDurations.sort((a, b) => a - b);
  const elapsed = total ? Math.max(1, lastTs - firstTs + 1) : 0;
  const sum = allDurations.reduce((a, b) => a + b, 0);
  const summary: LoadSummary = {
    totalRequests: total,
    failedRequests: failed,
    errorRate: total ? failed / total : 0,
    avgRps: elapsed ? total / elapsed : 0,
    peakRps,
    avgMs: total ? sum / total : 0,
    minMs: allDurations[0] ?? 0,
    maxMs: allDurations[allDurations.length - 1] ?? 0,
    p50: percentile(allDurations, 50),
    p90: percentile(allDurations, 90),
    p95: percentile(allDurations, 95),
    p99: percentile(allDurations, 99),
    statusCounts,
    durationSec: elapsed,
    abortReason,
  };
  removeDir(workDir);
  return { status: outcome, summary: summary as never, error: abortReason };
}
