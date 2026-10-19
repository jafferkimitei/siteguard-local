import { prisma } from '@siteguard/database';
import { SecurityConfig, type SecuritySummary } from '@siteguard/contracts';
import { audit, isCancelled, progress, saveFindings, tally, type FindingInput, type RunnerResult, type RunWithTarget } from './common';
import { runPassiveChecks } from './passive';
import { runZap } from './zap';

export async function runSecurity(run: RunWithTarget): Promise<RunnerResult> {
  const cfg = SecurityConfig.parse(run.config);
  const all: FindingInput[] = [];
  const checks: string[] = [];
  let cancelled = false;

  if (cfg.passive) {
    checks.push('passive');
    all.push(...(await runPassiveChecks(run.target, (m) => progress(run.id, m))));
    cancelled = await isCancelled(run.id);
  }
  if (!cancelled && (cfg.zapBaseline || cfg.zapActive)) {
    const mode = cfg.zapActive ? 'active' : 'baseline';
    checks.push(`zap-${mode}`);
    await progress(run.id, `Running OWASP ZAP ${mode} scan (this can take several minutes)`);
    if (mode === 'active') await audit(run.id, 'active-scan', 'Active scan started; target is marked as authorised');
    const z = await runZap(run.id, run.target, mode);
    all.push(...z.findings);
    cancelled = z.cancelled;
  }

  await saveFindings(run, all);
  const saved = await prisma.finding.findMany({ where: { runId: run.id }, select: { severity: true } });
  const summary: SecuritySummary = { findings: saved.length, bySeverity: tally(saved), checks };
  return { status: cancelled ? 'CANCELLED' : 'COMPLETED', summary: summary as never };
}
