import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import { Queue } from 'bullmq';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { ZodError, z } from 'zod';
import { CreateRun, ENV_REF, FindingStatus, JourneyInput, buildStressScript, extractInto, failedChecks, renderTemplate, stepRefs, type JourneyStep, journeyWarnings, QUEUE_NAME, TargetInput, TargetPatch, cancelKey, runChannel, sortBySeverity, type RunJobData } from '@siteguard/contracts';
import { audit, datasetsDir, env, prisma, reportsDir } from '@siteguard/database';
import { SafetyError, assertDestinationAllowed, loadDataset, validateJourney, validateLoadPlan, validateStressPlan } from '@siteguard/safety';
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

// ---------------- journeys ----------------
const parseJourney = async (targetId: string, body: unknown) => {
  const input = JourneyInput.parse(body);
  const target = await prisma.target.findUniqueOrThrow({ where: { id: targetId } });
  await validateJourney(input, target, { hasDataset: true }); // data refs are checked again against the chosen dataset when a run starts
  return { input, warnings: journeyWarnings(input) };
};
app.get('/targets/:id/journeys', async (req) => prisma.journey.findMany({ where: { targetId: id(req) }, orderBy: { createdAt: 'asc' } }));
app.post('/targets/:id/journeys', async (req, reply) => {
  const targetId = id(req);
  const { input, warnings } = await parseJourney(targetId, req.body);
  const journey = await prisma.journey.create({ data: { targetId, name: input.name, steps: input.steps as never } });
  await audit(null, 'journey.created', `Journey "${journey.name}" created`, { id: journey.id });
  return reply.code(201).send({ ...journey, warnings });
});
app.put('/journeys/:id', async (req) => {
  const existing = await prisma.journey.findUniqueOrThrow({ where: { id: id(req) } });
  const { input, warnings } = await parseJourney(existing.targetId, req.body);
  const journey = await prisma.journey.update({ where: { id: existing.id }, data: { name: input.name, steps: input.steps as never } });
  return { ...journey, warnings };
});
app.delete('/journeys/:id', async (req, reply) => {
  await prisma.journey.delete({ where: { id: id(req) } });
  return reply.code(204).send();
});

/** Run a journey once with a single bot (no load) so you can check it works before a stress test. */
app.post('/journeys/:id/dry-run', async (req) => {
  const { dataset } = z.object({ dataset: z.string().optional() }).parse(req.body ?? {});
  const j = await prisma.journey.findUniqueOrThrow({ where: { id: id(req) }, include: { target: true } });
  const steps = j.steps as unknown as JourneyStep[];
  await validateJourney({ name: j.name, steps }, j.target, { hasDataset: !!dataset });
  const row = dataset ? (JSON.parse(loadDataset(datasetsDir, dataset)) as Record<string, unknown>[])[0] ?? null : null;
  const secrets: Record<string, string> = {};
  for (const ref of steps.flatMap(stepRefs)) {
    const m = ENV_REF.exec(ref);
    if (!m) continue;
    if (process.env[m[1]!] === undefined) throw new SafetyError(`Environment variable ${m[1]} is referenced by this journey but is not set. Add it to your .env file.`);
    secrets[m[1]!] = process.env[m[1]!]!;
  }
  const origin = new URL(j.target.baseUrl).origin;
  const vars: Record<string, string> = {};
  const cookies = new Map<string, string>();
  const rc = { vars, row, secrets };
  const results: { step: string; kind: string; method: string; path: string; status: number; ms: number; extracted: string[]; failed: string[] }[] = [];
  for (const st of steps) {
    const url = origin + renderTemplate(st.path, rc, true);
    await assertDestinationAllowed(url, j.target);
    const headers: Record<string, string> = { 'user-agent': 'SiteGuardLocal/0.1 (journey dry run)' };
    for (const [k, v] of Object.entries(st.headers)) headers[k] = renderTemplate(v, rc, false);
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (st.bodyType === 'json') headers['content-type'] ??= 'application/json';
    if (st.bodyType === 'form') headers['content-type'] ??= 'application/x-www-form-urlencoded';
    const started = Date.now();
    let status = 0;
    let text = '';
    let resHeaders: Record<string, string> = {};
    let failed: string[] = [];
    try {
      const res = await fetch(url, { method: st.method, headers, body: st.bodyType === 'none' ? undefined : renderTemplate(st.body, rc, st.bodyType === 'form'), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      status = res.status;
      resHeaders = Object.fromEntries(res.headers.entries());
      for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair!.indexOf('='); if (i > 0) cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1)); }
      text = (await res.text()).slice(0, 200_000);
    } catch (err) {
      failed = [`request failed: ${err instanceof Error ? err.message : String(err)}`];
    }
    const res = { status, text, headers: resHeaders };
    const extracted = extractInto(st, res, vars);
    failed = [...failed, ...failedChecks(st, res, rc), ...(status === 0 || status >= 400 ? [`HTTP ${status || 'no response'}`] : [])];
    results.push({ step: st.name, kind: st.kind, method: st.method, path: st.path, status, ms: Date.now() - started, extracted, failed });
    if (status === 0 || status >= 400) if (st.kind === 'normal') break;
  }
  return { ok: results.every((r) => r.failed.length === 0), steps: results };
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

  if (input.type === 'STRESS') {
    validateStressPlan(input.config, target);
    const ids = input.config.mix.flatMap((m) => (m.journeyId ? [m.journeyId] : []));
    const journeys = await prisma.journey.findMany({ where: { id: { in: ids }, targetId: target.id } });
    if (journeys.length !== new Set(ids).size) throw new SafetyError('One of the selected journeys does not belong to this target');
    for (const j of journeys) await validateJourney({ name: j.name, steps: j.steps as never }, target, { hasDataset: !!input.config.dataset });
    for (const m of input.config.mix) for (const p of m.paths ?? []) await assertDestinationAllowed(new URL(p, target.baseUrl).toString(), target);
  }

  // Runs of any type, on the same or different targets, may run concurrently (including two LOAD/STRESS
  // runs stacked on one target — each one's own ceilings still apply individually, but their combined
  // rate against that target is not checked). The worker still serialises ZAP scans internally because
  // of a Docker networking constraint, independent of this.
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

app.get('/runs/:id', async (req) => {
  const run = await fullRun(id(req));
  sortBySeverity(run.findings);
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

app.get('/runs/:id/k6-script', async (req, reply) => {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: id(req) } });
  if (run.type !== 'STRESS') throw new SafetyError('Only stress runs have an exportable k6 script');
  return reply.header('content-type', 'text/javascript; charset=utf-8')
    .header('content-disposition', `attachment; filename="siteguard-stress-${run.id}.k6.js"`)
    .send(`// Generated by SiteGuard Local. The script reads its journeys and schedule from the CFG environment variable,\n// so run it through SiteGuard (which supplies CFG, BASE_URL, SECRETS_FILE and DATA_FILE) rather than directly.\n${buildStressScript()}`);
});

// ---------------- findings ----------------
app.get('/findings', async (req) => {
  const q = z.object({ targetId: z.string().optional(), status: FindingStatus.optional(), severity: z.string().optional(), limit: z.coerce.number().max(500).default(200) }).parse(req.query);
  const rows = await prisma.finding.findMany({
    where: { targetId: q.targetId, status: q.status, severity: q.severity },
    orderBy: { createdAt: 'desc' }, take: q.limit, include: { target: { select: { name: true } } },
  });
  return sortBySeverity(rows);
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
/** Top-level config keys whose values differ (hypothesis text is ignored). */
const diffConfig = (a: unknown, b: unknown): string[] => {
  const x = (a ?? {}) as Record<string, unknown>;
  const y = (b ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => k !== 'hypothesis' && JSON.stringify(x[k]) !== JSON.stringify(y[k]));
};

app.get('/compare', async (req) => {
  const { a, b } = z.object({ a: z.string(), b: z.string() }).parse(req.query);
  const [ra, rb] = await Promise.all([fullRun(a), fullRun(b)]);
  if (ra.type !== rb.type) throw new SafetyError('Can only compare runs of the same type');
  const configDiff = diffConfig(ra.config, rb.config);
  const fa = new Set(ra.findings.map((f) => f.fingerprint));
  const fb = new Set(rb.findings.map((f) => f.fingerprint));
  return {
    a: { id: ra.id, type: ra.type, createdAt: ra.createdAt, summary: ra.summary, config: ra.config, target: ra.target.name },
    b: { id: rb.id, type: rb.type, createdAt: rb.createdAt, summary: rb.summary, config: rb.config, target: rb.target.name },
    configDiff,
    warning: configDiff.length > 1 ? `${configDiff.length} settings differ between these runs (${configDiff.join(', ')}). Change one variable per iteration so you know what caused the difference.` : null,
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
