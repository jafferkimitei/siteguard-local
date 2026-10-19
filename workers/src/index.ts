import { Worker } from 'bullmq';
import { env, prisma } from '@siteguard/database';
import { QUEUE_NAME, type RunJobData } from '@siteguard/contracts';
import { audit, errMessage, isCancelled, publish, redis, type RunnerResult, type RunWithTarget } from './common';
import { runLoad } from './load';
import { runCrawl } from './crawler';
import { runSecurity } from './security';
import { runStress } from './stress';

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
    else if (run.type === 'STRESS') result = await runStress(run);
    else result = await runSecurity(run);
    await finish(runId, result.status, result.summary, result.error);
  } catch (err) {
    const message = errMessage(err);
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

  // Runs of any type, on the same or different targets, execute concurrently; tune via WORKER_CONCURRENCY.
  // Each run's own ceilings still apply to it individually — concurrent runs on one target are not
  // rate-limited in aggregate, so their req/s can add up against that target. ZAP is the one exception:
  // its Docker container binds a fixed proxy port, so runZap() serialises itself via a Redis lock
  // regardless of this setting.
  const worker = new Worker<RunJobData>(QUEUE_NAME, (job) => handleRun(job.data.runId), { connection: redis, concurrency: env.WORKER_CONCURRENCY });
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
