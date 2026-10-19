import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Target } from '@siteguard/database';
import { assertDestinationAllowed } from '@siteguard/safety';
import type { Severity } from '@siteguard/contracts';
import { isCancelled, progress, sleep, type FindingInput } from './common';
import { killContainer, makeWorkDir, removeDir, watchChild, withLock } from './proc';

const IMAGE = 'ghcr.io/zaproxy/zaproxy:stable';
const RISK: Record<string, Severity> = { '3': 'HIGH', '2': 'MEDIUM', '1': 'LOW', '0': 'INFO' };
const strip = (s?: string) => (s ?? '').replace(/<[^>]+>/g, '').trim();
// ZAP's Docker container binds a fixed internal proxy port with --network host, so two instances
// collide; this has nothing to do with how many other (non-ZAP) runs are executing concurrently.
const ZAP_LOCK_KEY = 'siteguard:zap-lock';

/** Runs ZAP in Docker. Baseline = passive spider+scan; active = full scan (needs explicit authorisation). */
export async function runZap(runId: string, target: Target, mode: 'baseline' | 'active'): Promise<{ findings: FindingInput[]; cancelled: boolean }> {
  if (mode === 'active' && !target.activeScanAuthorized)
    throw new Error('Active scanning requires the target to be marked "active scans authorised"');
  await assertDestinationAllowed(target.baseUrl, target);

  return withLock(ZAP_LOCK_KEY, runId, () => runZapLocked(runId, target, mode), {
    ttlMs: 20 * 60_000, // a full active scan can run long; renewed periodically while held
    onWaiting: () => progress(runId, 'Waiting for another ZAP scan to finish (only one can run at a time)'),
  });
}

async function runZapLocked(runId: string, target: Target, mode: 'baseline' | 'active'): Promise<{ findings: FindingInput[]; cancelled: boolean }> {
  const workDir = makeWorkDir(`${runId}-zap`);
  const name = `sg-zap-${runId}`;
  const script = mode === 'active' ? 'zap-full-scan.py' : 'zap-baseline.py';
  const child = spawn('docker', ['run', '--rm', '--name', name, '--network', 'host', '-v', `${workDir}:/zap/wrk:rw`, IMAGE,
    script, '-t', new URL(target.baseUrl).origin, '-J', 'report.json', '-I', '-m', '3']);
  const proc = watchChild(child);

  let cancelled = false;
  while (proc.exitCode() === null) {
    await sleep(500);
    if (await isCancelled(runId)) {
      cancelled = true;
      killContainer(name);
      break;
    }
  }
  if (cancelled) { removeDir(workDir); return { findings: [], cancelled }; }

  const findings: FindingInput[] = [];
  try {
    const report = JSON.parse(readFileSync(join(workDir, 'report.json'), 'utf8'));
    for (const site of report.site ?? []) {
      for (const a of site.alerts ?? []) {
        const inst = a.instances?.[0];
        findings.push({ source: 'ZAP', severity: RISK[String(a.riskcode)] ?? 'INFO', title: a.name ?? a.alert,
          description: strip(a.desc), remediation: strip(a.solution), url: inst?.uri ?? target.baseUrl,
          evidence: [inst?.evidence, a.instances?.length > 1 ? `${a.instances.length} instances` : ''].filter(Boolean).join(' — ') || undefined });
      }
    }
  } catch {
    removeDir(workDir);
    throw new Error(`ZAP produced no report (exit ${proc.exitCode()}). ${proc.stderr().trim().slice(-400)}`);
  }
  removeDir(workDir);
  return { findings, cancelled: false };
}
