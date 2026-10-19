import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { Prisma, env, prisma, type Run, type Target } from '@siteguard/database';
import { cancelKey, runChannel, type RunEvent, type RunStatus, type Severity } from '@siteguard/contracts';

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export type RunWithTarget = Run & { target: Target };

export interface RunnerResult {
  status: Extract<RunStatus, 'COMPLETED' | 'CANCELLED' | 'ABORTED'>;
  summary: Prisma.InputJsonValue;
  error?: string;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function publish(runId: string, ev: RunEvent) {
  await redis.publish(runChannel(runId), JSON.stringify(ev));
}

export async function isCancelled(runId: string) {
  return (await redis.exists(cancelKey(runId))) === 1;
}

export async function audit(runId: string, kind: string, message: string, data?: Prisma.InputJsonValue) {
  await prisma.auditEvent.create({ data: { runId, kind, message, data } });
}

export async function progress(runId: string, message: string, done?: number, total?: number) {
  await publish(runId, { kind: 'progress', message, done, total });
}

export function fingerprint(...parts: (string | undefined)[]) {
  return createHash('sha1').update(parts.map((p) => p ?? '').join('|')).digest('hex').slice(0, 16);
}

export interface FindingInput {
  source: 'PASSIVE' | 'CRAWLER' | 'ZAP';
  severity: Severity;
  title: string;
  description: string;
  evidence?: string;
  remediation?: string;
  url?: string;
}

export async function saveFindings(run: RunWithTarget, findings: FindingInput[]) {
  if (findings.length === 0) return;
  // De-duplicate within a run on the same fingerprint.
  const seen = new Set<string>();
  const rows = findings.flatMap((f) => {
    const fp = fingerprint(f.source, f.title, f.url);
    if (seen.has(fp)) return [];
    seen.add(fp);
    return [{ ...f, runId: run.id, targetId: run.targetId, fingerprint: fp }];
  });
  await prisma.finding.createMany({ data: rows });
  for (const f of rows) await publish(run.id, { kind: 'finding', title: f.title, severity: f.severity });
}

export function tally(findings: { severity: string }[]) {
  const bySeverity: Record<string, number> = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  return bySeverity;
}
