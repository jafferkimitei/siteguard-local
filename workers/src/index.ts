import { Worker } from 'bullmq';
import { prisma } from '@siteguard/database';
import { QUEUE_NAME, type RunJobData } from '@siteguard/contracts';
import { audit, isCancelled, publish, redis, type RunnerResult, type RunWithTarget } from './common';
import { runLoad } from './load';
import { runCrawl } from './crawler';
import { runSecurity } from './security';

async function finish(runId: string, status: string, summary?: unknown, error?: string) {
  await prisma.run.update({
    where: { id: runId },
    data: { status, summary: (summary ?? undefined) as never, error, finishedAt: new Date() },
  });
  await publish(runId, { kind: 'status', status: status as never, error });
  await audit(runId, status.toLowerCase(), error ?? `Run ${status.toLowerCase()}`);
}

async function handleRun(runId: string) {
  const run = (await prisma.run.findUnique({ where: { id: runId }, include: { target: true } })) as RunWithTarget | null;
  if (!run || run.status !== 'QUEUED') return;
  if (await isCancelled(runId)) return finish(runId, 'CANCELLED');

  await prisma.run.update({ where: { id: runId }, data: { status: 'RUNNING', startedAt: new Date() } });
  await publish(runId, { kind: 'status', status: 'RUNNING' });
  await audit(runId, 'started', `${run.type} run started against ${run.target.baseUrl}`, run.config as never);

  try {
    let result: RunnerResult;
    if (run.type === 'LOAD') result = await runLoad(run);
    else if (run.type === 'CRAWL') result = await runCrawl(run);
    else result = await runSecurity(run);
    await finish(runId, result.status, result.summary, result.error);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[run ${runId}] failed:`, message);
    await finish(runId, 'FAILED', undefined, message);
  }
}

async function main() {
  // A previous worker may have died mid-run; don't leave those hanging as RUNNING forever.
  const stale = await prisma.run.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'FAILED', error: 'Worker restarted while the run was in progress', finishedAt: new Date() },
  });
  if (stale.count) console.log(`marked ${stale.count} stale run(s) as FAILED`);

  // concurrency 1: one test at a time keeps the local machine and the target predictable.
  const worker = new Worker<RunJobData>(QUEUE_NAME, (job) => handleRun(job.data.runId), { connection: redis, concurrency: 1 });
  worker.on('failed', (job, err) => console.error('job failed', job?.id, err.message));
  console.log('worker ready, waiting for runs…');

  const shutdown = async () => {
    await worker.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
