import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetricPointDTO } from '@siteguard/contracts';
import { env, prisma } from '@siteguard/database';
import { percentile } from '@siteguard/safety';
import { audit, isCancelled, progress, publish, sleep, type RunWithTarget } from './common';
import { killContainer, watchChild } from './proc';

export const PRIVATE_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'];
export const METADATA_CIDRS = ['169.254.0.0/16'];

const hasLocalK6 = () => spawnSync('k6', ['version'], { stdio: 'ignore' }).status === 0;

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

/** One k6 JSON-output sample. */
export interface K6Record {
  metric: string;
  /** Epoch seconds. */
  sec: number;
  value: number;
  tags: Record<string, string>;
}

export interface K6Result {
  outcome: 'COMPLETED' | 'CANCELLED' | 'ABORTED';
  abortReason?: string;
  /** Set when onTick ended the run early on purpose. */
  completedEarly?: string;
  exitCode: number | null;
  stderr: string;
}

export interface K6RunOptions {
  run: RunWithTarget;
  workDir: string;
  script: string;
  /** Environment for the script. Receives the work dir as k6 sees it (differs under Docker). */
  env: (workDirAsSeenByK6: string) => Record<string, string>;
  startMessage: string;
  auditData: object;
  onRecord: (rec: K6Record) => void;
  /**
   * Called about once a second. A string aborts the run (a safety stop); `{ complete }` ends it early
   * as a normal result (e.g. the breaking point was found).
   */
  onTick: () => Promise<string | { complete: string } | null>;
}

/** Spawn k6 (local binary or Docker), stream its samples into onRecord, and honour cancel / stop rules. */
export async function runK6(o: K6RunOptions): Promise<K6Result> {
  writeFileSync(join(o.workDir, 'script.js'), o.script);
  const outFile = join(o.workDir, 'out.ndjson');
  writeFileSync(outFile, '');
  chmodSync(outFile, 0o666);

  const useLocal = env.K6_MODE === 'local' || (env.K6_MODE === 'auto' && hasLocalK6());
  const k6Env = o.env(useLocal ? o.workDir : '/work');
  const containerName = `sg-k6-${o.run.id}`;
  let child: ChildProcess;
  if (useLocal) {
    child = spawn('k6', ['run', '--quiet', '--no-usage-report', '--out', `json=${outFile}`, join(o.workDir, 'script.js')], {
      env: { ...process.env, ...k6Env },
    });
  } else {
    const uid = process.getuid?.() ?? 1000;
    const envArgs = Object.entries(k6Env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    child = spawn('docker', ['run', '--rm', '--name', containerName, '--network', 'host', '--user', `${uid}`, ...envArgs, '-v', `${o.workDir}:/work`,
      env.K6_DOCKER_IMAGE, 'run', '--quiet', '--no-usage-report', '--out', 'json=/work/out.ndjson', '/work/script.js']);
  }
  await audit(o.run.id, 'engine', `k6 started (${useLocal ? 'local binary' : 'docker ' + env.K6_DOCKER_IMAGE})`, o.auditData);
  await progress(o.run.id, o.startMessage);

  const proc = watchChild(child, 4000);
  const kill = () => (useLocal ? child.kill('SIGTERM') : killContainer(containerName));
  const tail = new Tailer(outFile);
  const ingest = (line: string) => {
    let rec: { type: string; metric: string; data: { time: string; value: number; tags?: Record<string, string> } };
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    if (rec.type !== 'Point') return;
    o.onRecord({ metric: rec.metric, sec: Math.floor(new Date(rec.data.time).getTime() / 1000), value: rec.data.value, tags: rec.data.tags ?? {} });
  };

  let outcome: K6Result['outcome'] = 'COMPLETED';
  let abortReason: string | undefined;
  let completedEarly: string | undefined;
  let lastCheck = 0;
  while (proc.exitCode() === null) {
    await sleep(250);
    for (const line of tail.read()) ingest(line);
    if (await isCancelled(o.run.id)) {
      outcome = 'CANCELLED';
      kill();
      break;
    }
    if (Date.now() - lastCheck >= 1000) {
      lastCheck = Date.now();
      const reason = await o.onTick();
      if (reason && typeof reason === 'object') {
        completedEarly = reason.complete;
        kill();
        await audit(o.run.id, 'stopped-early', reason.complete);
        break;
      }
      if (reason) {
        outcome = 'ABORTED';
        abortReason = reason;
        kill();
        await audit(o.run.id, 'abort', reason);
        break;
      }
    }
  }
  // Give the process a moment to exit, then drain whatever it wrote last.
  for (let i = 0; i < 20 && proc.exitCode() === null; i++) await sleep(100);
  await sleep(200);
  for (const line of tail.read()) ingest(line);
  tail.close();
  return { outcome, abortReason, completedEarly, exitCode: proc.exitCode(), stderr: proc.stderr() };
}

/** k6 exit 99 = a threshold failed; we define none, so any other non-zero exit is an engine error. */
export function engineError(r: K6Result): Error | null {
  if (r.outcome !== 'COMPLETED' || r.completedEarly || r.exitCode === 0 || r.exitCode === 99) return null;
  return new Error(`k6 exited with code ${r.exitCode}: ${r.stderr.trim().slice(-800) || 'no output'}`);
}

interface Bucket {
  durations: number[];
  failed: number;
  vus: number;
}

/** Per-second request buckets: emits live points, persists them in batches, and answers stop-rule queries. */
export class MetricsCollector {
  readonly allDurations: number[] = [];
  readonly statusCounts: Record<string, number> = {};
  total = 0;
  failed = 0;
  peakRps = 0;
  private firstTs = Infinity;
  private lastTs = 0;
  private lastVus = 0;
  private emittedUpTo = 0;
  private readonly buckets = new Map<number, Bucket>();
  private readonly pending: MetricPointDTO[] = [];
  /** Hook for per-point extras (stress adds the scheduled bot level and phase). */
  constructor(private runId: string, private decorate: (pointTs: number) => Partial<MetricPointDTO> = () => ({}), private onPoint?: (p: MetricPointDTO) => void) {}

  private bucketOf(sec: number) {
    let b = this.buckets.get(sec);
    if (!b) this.buckets.set(sec, (b = { durations: [], failed: 0, vus: this.lastVus }));
    return b;
  }

  ingest(rec: K6Record) {
    if (rec.metric === 'vus') {
      this.lastVus = rec.value;
      this.bucketOf(rec.sec).vus = rec.value;
    } else if (rec.metric === 'http_req_duration') {
      const ok = rec.tags.expected_response === 'true';
      const b = this.bucketOf(rec.sec);
      b.durations.push(rec.value);
      if (!ok) b.failed++;
      this.allDurations.push(rec.value);
      const status = rec.tags.status ?? '0';
      this.statusCounts[status] = (this.statusCounts[status] ?? 0) + 1;
      this.total++;
      if (!ok) this.failed++;
      this.firstTs = Math.min(this.firstTs, rec.sec);
      this.lastTs = Math.max(this.lastTs, rec.sec);
    }
  }

  private toPoint(sec: number, b: Bucket): MetricPointDTO {
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
      ...this.decorate(sec),
    };
  }

  /** Emit every fully-elapsed second (leaving a 1s lag so late points still land in the right bucket). */
  async flush(final = false) {
    const limit = final ? Infinity : Math.floor(Date.now() / 1000) - 1;
    const secs = [...this.buckets.keys()].filter((s) => s > this.emittedUpTo && s <= limit).sort((a, b) => a - b);
    for (const sec of secs) {
      const point = this.toPoint(sec, this.buckets.get(sec)!);
      this.peakRps = Math.max(this.peakRps, point.rps);
      this.emittedUpTo = sec;
      this.pending.push(point);
      this.onPoint?.(point);
      await publish(this.runId, { kind: 'metric', point });
    }
    if (this.pending.length >= 5 || (final && this.pending.length)) {
      const batch = this.pending.splice(0);
      await prisma.metricPoint.createMany({ data: batch.map((p) => ({ ...p, ts: new Date(p.ts), runId: this.runId })) });
    }
    return secs.length;
  }

  /** Stats over the last five seconds with data, for stop rules. */
  windowStats() {
    const recent = [...this.buckets.keys()].sort((a, b) => b - a).slice(0, 5);
    const ds: number[] = [];
    let f = 0;
    for (const s of recent) {
      const b = this.buckets.get(s)!;
      ds.push(...b.durations);
      f += b.failed;
    }
    ds.sort((a, b) => a - b);
    return { requests: ds.length, errorRate: ds.length ? f / ds.length : 0, p95: percentile(ds, 95) };
  }

  elapsedSec() {
    return this.total ? Math.max(1, this.lastTs - this.firstTs + 1) : 0;
  }
}
