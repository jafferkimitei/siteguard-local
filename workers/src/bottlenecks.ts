import { statusMeaning, type StressSummary } from '@siteguard/contracts';
import type { FindingInput } from './common';

const SATURATION_FIXES = [
  'Database connection pool exhausted: raise the pool size, or find slow queries that hold connections longer than necessary.',
  'CPU maxed on application servers: profile for hot code paths, or scale out with more instances.',
  'Memory maxed or garbage collection thrashing: raise the heap, or fix memory leaks.',
  'Server worker or thread pool saturated: raise the pool size, or move expensive work to background jobs.',
  'External API rate-limited: add retry with backoff, cache responses, or switch to asynchronous processing.',
].join('\n');

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Turn a stress summary into findings. These are indicators seen from outside, not proof of a cause. */
export function bottleneckFindings(s: StressSummary, baseUrl: string): FindingInput[] {
  const f: FindingInput[] = [];
  const add = (x: Omit<FindingInput, 'source' | 'url'> & { url?: string }) => f.push({ source: 'STRESS', url: baseUrl, ...x });
  const curve = s.levels.map((l) => `${l.bots} bots: ${l.rps.toFixed(1)} req/s, p95 ${Math.round(l.p95)} ms, ${pct(l.errorRate)} errors`).join('\n');

  if (s.breakingPoint) {
    add({
      severity: s.breakingPoint.kind === 'errors' ? 'HIGH' : 'MEDIUM',
      title: `Breaking point at ${s.breakingPoint.bots} concurrent bots`,
      description: `${s.breakingPoint.reason}. This is the load level where the site stopped coping, measured from outside (${s.breakingPoint.rps.toFixed(1)} req/s).`,
      evidence: curve,
      remediation: 'Find which resource saturates first and raise or relieve it, then run the same test again to confirm the knee moves right.',
    });
  }

  for (const p of s.patterns) {
    if (p.pattern === 'hockey-stick')
      add({ severity: 'MEDIUM', title: 'Hockey-stick latency: a resource saturated', description: p.message, evidence: curve, remediation: SATURATION_FIXES });
    else if (p.pattern === 'errors-first')
      add({ severity: 'MEDIUM', title: 'Errors appeared before slowness', description: p.message, evidence: curve,
        remediation: 'Check rate-limit and circuit-breaker settings and queue limits. If the limiter is intentional, raise it only as far as the app can really cope.' });
    else if (p.pattern === 'partial-failure')
      add({ severity: 'HIGH', title: 'Partial failure: some features break while others stay up', description: p.message,
        evidence: s.steps.map((st) => `${st.journey} / ${st.step}: ${pct(st.errorRate)} errors, p95 ${Math.round(st.p95)} ms`).join('\n'),
        remediation: 'Look at what only the failing steps depend on (a database table, payment, search or email service) and give it more capacity or a fallback.' });
    else if (p.pattern === 'gradual')
      add({ severity: 'LOW', title: 'Latency grew steadily with load', description: p.message, evidence: curve,
        remediation: 'Look for work that scales with load: missing indexes, N+1 queries, unbounded caches or lists.' });
  }

  for (const [code, n] of Object.entries(s.statusCounts)) {
    const c = Number(code);
    if (c < 400 && c !== 0) continue;
    if (n < 5) continue;
    const m = statusMeaning(code);
    add({
      severity: c >= 500 || c === 0 ? 'HIGH' : 'LOW',
      title: c === 0 ? 'Requests got no response' : `HTTP ${code} returned ${n} times (${m.meaning})`,
      description: `${m.meaning}. ${m.cause}`,
      evidence: `${n} of ${s.totalRequests} requests (${pct(n / Math.max(1, s.totalRequests))})`,
      remediation: c === 503 ? 'The server is shedding load. Add capacity or queue limits, or put a cache in front of expensive pages.'
        : c === 504 ? 'Find the slow upstream (app or database). Raise timeouts only after fixing why it is slow.'
          : c === 502 ? 'Check that app processes are not crashing or restarting under load (look at process manager and container logs).'
            : c === 429 ? 'A rate limiter fired. If it is yours, test from an allow-listed address or raise the limit on staging.'
              : 'Check application and database logs for the failing requests.',
    });
  }

  for (const [kind, n] of Object.entries(s.errorKinds)) {
    if (n < 5) continue;
    add({
      severity: 'HIGH',
      title: `${n} requests failed with: ${kind}`,
      description: kind === 'timeout' ? 'Requests were not answered in time. Workers or connections were saturated.'
        : kind === 'connection refused' ? 'The server stopped accepting connections. The process may have crashed, or the listen backlog is full.'
          : kind === 'connection reset' ? 'Connections were dropped mid-request, which often means a proxy or the app closed them under pressure.'
            : 'The network layer reported errors.',
      remediation: 'Check the server process, file-descriptor and connection limits, and reverse-proxy worker settings.',
    });
  }

  if (s.recovery && !s.recovery.recovered)
    add({
      severity: 'HIGH', title: 'The site did not recover after the load dropped',
      description: `After load fell to baseline, p95 stayed at ${Math.round(s.recovery.residualP95)} ms with ${pct(s.recovery.residualErrorRate)} errors.`,
      remediation: 'Look for stuck transactions, exhausted connection pools, full background queues or cascading failures. An app that needs a manual restart after a spike is a serious operability risk.',
    });
  else if (s.recovery?.recovered && (s.recovery.secondsToBaseline ?? 0) > 30)
    add({ severity: 'LOW', title: `Slow recovery: ${s.recovery.secondsToBaseline}s to return to normal`, description: 'The site recovered, but slowly.', remediation: 'Check queue drain rate and cache warm-up time.' });

  if (s.integrity && s.integrity.failures > 0)
    add({ severity: 'CRITICAL', title: 'Data-integrity checks failed after the load',
      description: `${s.integrity.failures} of ${s.integrity.checks} verification checks failed. The test finished, but the data afterwards is wrong (for example duplicate orders or stuck transactions). This does not show up in response times.`,
      remediation: 'Make order and payment creation idempotent, wrap multi-step writes in transactions, and check for race conditions under concurrency.' });

  if (s.driftPct !== null && s.driftPct > 0.25)
    add({ severity: 'MEDIUM', title: `Latency drifted up ${(s.driftPct * 100).toFixed(0)}% during the soak`,
      description: 'Response time kept growing while load was constant. This pattern is typical of a memory leak, a connection or file-descriptor leak, or a cache or table that grows without bounds.',
      remediation: 'Watch memory and open connections over time on the server, take heap snapshots at the start and end of the soak, and look for unbounded growth.' });

  if (s.cacheHitRatio !== null && s.cacheHitRatio < 0.5)
    add({ severity: 'LOW', title: `Low cache hit ratio (${pct(s.cacheHitRatio)})`, description: 'Most responses came from the origin rather than a CDN or cache, so the origin carries nearly all the load.',
      remediation: 'Add cache headers for static and cacheable pages; check cache keys and cookies that prevent caching.' });

  if (s.wafBlocks > 0)
    add({ severity: 'MEDIUM', title: `${s.wafBlocks} responses looked like WAF or rate-limit blocks`,
      description: 'Some test traffic was refused with 429 or a challenge page. Results above that point measure the protection layer, not your application.',
      remediation: 'For a meaningful capacity test, allow-list the test machine on staging, or tune the WAF rules and verify they do not block legitimate user paths.' });

  const slowest = [...s.steps].filter((st) => st.requests >= 20).sort((a, b) => b.p95 - a.p95)[0];
  if (slowest && s.steps.length > 1)
    add({ severity: 'INFO', title: `Slowest step: ${slowest.step}`, description: `"${slowest.step}" in "${slowest.journey}" had the highest p95 (${Math.round(slowest.p95)} ms).`,
      remediation: 'Start optimising here: it is where users wait longest.' });

  if (s.ceilingReached)
    add({ severity: 'INFO', title: 'The target\'s req/s ceiling was reached',
      description: 'Throughput levelled off at the pacing limit for this target, so a plateau here reflects the configured ceiling, not necessarily the server.',
      remediation: 'Raise the target\'s stress req/s ceiling to find the server\'s real limit (only if it is safe to do so).' });

  return f;
}
