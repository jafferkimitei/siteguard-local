import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import { Queue } from 'bullmq';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { ZodError, z } from 'zod';
import { CreateRun, FindingStatus, QUEUE_NAME, TargetInput, TargetPatch, cancelKey, runChannel, type RunJobData } from '@siteguard/contracts';
import { env, prisma, reportsDir, type Target } from '@siteguard/database';
import { SafetyError, assertDestinationAllowed, validateLoadPlan } from '@siteguard/safety';
import { runToCsv, runToHtml, type FullRun } from './report';

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue<RunJobData>(QUEUE_NAME, { connection: redis });
const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, { origin: [env.DASHBOARD_ORIGIN, 'http://127.0.0.1:5173'] });

app.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'Validation failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  if (err instanceof SafetyError) return reply.code(422).send({ error: err.message, safety: true });
  if (err.code === 'P2025') return reply.code(404).send({ error: 'Not found' });
  app.log.error(err);
  return reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'Internal error' });
});

const id = (req: { params: unknown }) => z.object({ id: z.string() }).parse(req.params).id;
const audit = (runId: string | null, kind: string, message: string, data?: object) =>
  prisma.auditEvent.create({ data: { runId, kind, message, data: data as never } });

// ---------------- health ----------------
app.get('/health', async (_req, reply) => {
  const checks = { database: false, redis: false };
  try { await prisma.$queryRaw`SELECT 1`; checks.database = true; } catch { /* reported below */ }
  try { checks.redis = (await redis.ping()) === 'PONG'; } catch { /* reported below */ }
  return reply.code(checks.database && checks.redis ? 200 : 503).send({ ok: checks.database && checks.redis, ...checks });
});

// ---------------- targets ----------------
app.get('/targets', () => prisma.target.findMany({ orderBy: { createdAt: 'desc' } }));
app.get('/targets/:id', async (req) => prisma.target.findUniqueOrThrow({ where: { id: id(req) } }));

app.post('/targets', async (req, reply) => {
  const input = TargetInput.parse(req.body);
  const t = new URL(input.baseUrl);
  // Fail early on bad destinations (metadata IPs always; private ranges unless opted in).
  await assertDestinationAllowed(t.origin, { ...input, baseUrl: t.origin });
  const target = await prisma.target.create({ data: { ...input, baseUrl: t.origin + (t.pathname === '/' ? '' : t.pathname) } });
  await audit(null, 'target.created', `Target ${target.name} (${target.baseUrl}) registered`, { id: target.id });
  return reply.code(201).send(target);
});

app.patch('/targets/:id', async (req) => {
  const patch = TargetPatch.parse(req.body);
  const target = await prisma.target.update({ where: { id: id(req) }, data: patch });
  await audit(null, 'target.updated', `Target ${target.name} updated`, patch);
  return target;
});

app.delete('/targets/:id', async (req, reply) => {
  await prisma.target.delete({ where: { id: id(req) } });
  return reply.code(204).send();
});

// ---------------- runs ----------------
app.get('/runs', async (req) => {
  const q = z.object({ targetId: z.string().optional(), type: z.string().optional(), limit: z.coerce.number().max(200).default(50) }).parse(req.query);
  return prisma.run.findMany({ where: { targetId: q.targetId, type: q.type }, orderBy: { createdAt: 'desc' }, take: q.limit, include: { target: { select: { name: true, baseUrl: true } } } });
});

app.post('/runs', async (req, reply) => {
  const input = CreateRun.parse(req.body);
  const target = await prisma.target.findUniqueOrThrow({ where: { id: input.targetId } });

  // Every guard runs here AND again inside the worker.
  await assertDestinationAllowed(target.baseUrl, target);
  if (input.type === 'LOAD') {
    validateLoadPlan(input.config, target);
    for (const p of input.config.paths) await assertDestinationAllowed(new URL(p, target.baseUrl).toString(), target);
  }
  if (input.type === 'SECURITY' && input.config.zapActive && !target.activeScanAuthorized)
    throw new SafetyError('Active scans require this target to be marked as "active scans authorised"');

  const active = await prisma.run.count({ where: { targetId: target.id, status: { in: ['QUEUED', 'RUNNING'] }, type: input.type } });
  if (active) throw new SafetyError(`A ${input.type} run is already queued or running for this target`);

  const run = await prisma.run.create({ data: { targetId: target.id, type: input.type, config: input.config as never } });
  await audit(run.id, 'queued', `${input.type} run queued for ${target.baseUrl}`, input.config);
  await queue.add('run', { runId: run.id }, { jobId: run.id, removeOnComplete: 100, removeOnFail: 100 });
  return reply.code(201).send(run);
});

const fullRun = (runId: string) =>
  prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: { target: true, metrics: { orderBy: { ts: 'asc' } }, pages: { orderBy: { id: 'asc' } }, findings: { orderBy: { createdAt: 'asc' } } },
  });

const SEV_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
app.get('/runs/:id', async (req) => {
  const run = await fullRun(id(req));
  run.findings.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  return run;
});

app.post('/runs/:id/cancel', async (req, reply) => {
  const runId = id(req);
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
  if (!['QUEUED', 'RUNNING'].includes(run.status)) return reply.code(409).send({ error: `Run is already ${run.status}` });
  await redis.set(cancelKey(runId), '1', 'EX', 3600);
  if (run.status === 'QUEUED') {
    await queue.remove(runId).catch(() => undefined);
    await prisma.run.update({ where: { id: runId }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    await redis.publish(runChannel(runId), JSON.stringify({ kind: 'status', status: 'CANCELLED' }));
  }
  await audit(runId, 'cancel.requested', 'Cancellation requested from dashboard');
  return { ok: true };
});

// Live updates (Server-Sent Events): relays whatever the worker publishes to Redis.
app.get('/runs/:id/stream', async (req, reply) => {
  const runId = id(req);
  const sub = new Redis(env.REDIS_URL);
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    'access-control-allow-origin': req.headers.origin ?? env.DASHBOARD_ORIGIN,
  });
  reply.raw.write(': connected\n\n');
  await sub.subscribe(runChannel(runId));
  sub.on('message', (_c, msg) => reply.raw.write(`data: ${msg}\n\n`));
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
  req.raw.on('close', () => { clearInterval(ping); sub.disconnect(); });
});

// ---------------- exports ----------------
app.get('/runs/:id/export', async (req, reply) => {
  const { format } = z.object({ format: z.enum(['json', 'csv', 'html']).default('json') }).parse(req.query);
  const run = (await fullRun(id(req))) as FullRun;
  const body = format === 'json' ? JSON.stringify(run, null, 2) : format === 'csv' ? runToCsv(run) : runToHtml(run);
  const type = { json: 'application/json', csv: 'text/csv', html: 'text/html' }[format];
  const filename = `siteguard-${run.type.toLowerCase()}-${run.id}.${format}`;
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, filename), body); // local copy under reports/
  return reply.header('content-type', `${type}; charset=utf-8`).header('content-disposition', `attachment; filename="${filename}"`).send(body);
});

// ---------------- findings ----------------
app.get('/findings', async (req) => {
  const q = z.object({ targetId: z.string().optional(), status: FindingStatus.optional(), severity: z.string().optional(), limit: z.coerce.number().max(500).default(200) }).parse(req.query);
  const rows = await prisma.finding.findMany({
    where: { targetId: q.targetId, status: q.status, severity: q.severity },
    orderBy: { createdAt: 'desc' }, take: q.limit, include: { target: { select: { name: true } } },
  });
  return rows.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
});

app.patch('/findings/:id', async (req) => {
  const { status } = z.object({ status: FindingStatus }).parse(req.body);
  const f = await prisma.finding.update({ where: { id: id(req) }, data: { status } });
  // Apply the same decision to identical findings from other runs so history stays consistent.
  await prisma.finding.updateMany({ where: { targetId: f.targetId, fingerprint: f.fingerprint, status: { not: status } }, data: { status } });
  await audit(f.runId, 'finding.status', `Finding "${f.title}" marked ${status}`);
  return f;
});

// ---------------- compare ----------------
app.get('/compare', async (req) => {
  const { a, b } = z.object({ a: z.string(), b: z.string() }).parse(req.query);
  const [ra, rb] = await Promise.all([fullRun(a), fullRun(b)]);
  if (ra.type !== rb.type) throw new SafetyError('Can only compare runs of the same type');
  const fa = new Set(ra.findings.map((f) => f.fingerprint));
  const fb = new Set(rb.findings.map((f) => f.fingerprint));
  return {
    a: { id: ra.id, type: ra.type, createdAt: ra.createdAt, summary: ra.summary, config: ra.config, target: ra.target.name },
    b: { id: rb.id, type: rb.type, createdAt: rb.createdAt, summary: rb.summary, config: rb.config, target: rb.target.name },
    findings: {
      newInB: rb.findings.filter((f) => !fa.has(f.fingerprint)),
      resolvedInB: ra.findings.filter((f) => !fb.has(f.fingerprint)),
      unchanged: rb.findings.filter((f) => fa.has(f.fingerprint)).length,
    },
  };
});

// ---------------- overview + audit ----------------
app.get('/overview', async () => {
  const [targets, runs, openFindings, recentRuns, recentFindings, loadRuns] = await Promise.all([
    prisma.target.count(),
    prisma.run.count(),
    prisma.finding.groupBy({ by: ['severity'], where: { status: 'OPEN' }, _count: true }),
    prisma.run.findMany({ orderBy: { createdAt: 'desc' }, take: 8, include: { target: { select: { name: true } } } }),
    prisma.finding.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' }, take: 8, include: { target: { select: { name: true } } } }),
    prisma.run.findMany({ where: { type: 'LOAD', status: { in: ['COMPLETED', 'ABORTED'] } }, orderBy: { createdAt: 'desc' }, take: 12, select: { id: true, createdAt: true, summary: true } }),
  ]);
  return {
    targets, runs,
    openFindings: Object.fromEntries(openFindings.map((g) => [g.severity, g._count])),
    recentRuns, recentFindings,
    loadTrend: loadRuns.reverse().map((r) => ({ id: r.id, createdAt: r.createdAt, ...(r.summary as object) })),
  };
});

app.get('/runs/:id/audit', async (req) => prisma.auditEvent.findMany({ where: { runId: id(req) }, orderBy: { id: 'asc' } }));

const port = env.API_PORT;
await app.listen({ port, host: '127.0.0.1' });
export type { Target };
