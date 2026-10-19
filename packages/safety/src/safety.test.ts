import { describe, expect, it } from 'vitest';
import { LoadConfig } from '@siteguard/contracts';
import {
  SafetyError, assertDestinationAllowed, estimateRequests, evaluateStopRules, isInScope, isMetadataIp, isPrivateIp, percentile, validateLoadPlan,
} from './index';

const target = { baseUrl: 'http://localhost:4000', extraHosts: [], allowPrivateNetwork: true, maxRps: 5, maxDurationSec: 60, maxRequests: 500 };

describe('ip classification', () => {
  it('flags private and metadata ranges', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.20.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.5')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isMetadataIp('169.254.169.254')).toBe(true);
    expect(isMetadataIp('::ffff:169.254.169.254')).toBe(true);
    expect(isMetadataIp('10.0.0.1')).toBe(false);
  });
});

describe('scope', () => {
  it('only allows registered hosts', () => {
    expect(isInScope('http://localhost:4000/a', target)).toBe(true);
    expect(isInScope('http://evil.com/a', target)).toBe(false);
    expect(isInScope('ftp://localhost/a', target)).toBe(false);
  });
  it('blocks loopback unless the target opts in', async () => {
    await expect(assertDestinationAllowed('http://127.0.0.1/', { ...target, baseUrl: 'http://127.0.0.1', allowPrivateNetwork: false })).rejects.toThrow(SafetyError);
    await expect(assertDestinationAllowed('http://localhost:4000/', target)).resolves.toBeUndefined();
  });
  it('blocks metadata even with allowPrivateNetwork', async () => {
    const t = { ...target, baseUrl: 'http://169.254.169.254' };
    await expect(assertDestinationAllowed('http://169.254.169.254/latest', t)).rejects.toThrow(/metadata/);
  });
});

describe('load plan', () => {
  it('estimates ramp + plateau', () => {
    expect(estimateRequests(10, 10, 0)).toBe(100);
    expect(estimateRequests(10, 20, 10)).toBe(150);
  });
  it('rejects plans over the ceilings', () => {
    const base = LoadConfig.parse({});
    expect(() => validateLoadPlan({ ...base, rps: 6 }, target)).toThrow(/ceiling/);
    expect(() => validateLoadPlan({ ...base, durationSec: 120 }, target)).toThrow(/limit/);
    expect(() => validateLoadPlan({ ...base, rps: 5, durationSec: 60, rampUpSec: 0 }, { ...target, maxRequests: 200 })).toThrow(/budget/);
    expect(validateLoadPlan({ ...base, rps: 2, durationSec: 30, rampUpSec: 5 }, target).estimatedRequests).toBe(55);
  });
});

describe('stop rules', () => {
  const rules = { maxErrorRate: 0.2, maxP95Ms: 500 };
  it('ignores tiny samples', () => expect(evaluateStopRules({ requests: 3, errorRate: 1, p95: 9999 }, rules)).toBeNull());
  it('trips on error rate and latency', () => {
    expect(evaluateStopRules({ requests: 50, errorRate: 0.5, p95: 10 }, rules)).toMatch(/Error rate/);
    expect(evaluateStopRules({ requests: 50, errorRate: 0, p95: 900 }, rules)).toMatch(/p95/);
    expect(evaluateStopRules({ requests: 50, errorRate: 0.1, p95: 100 }, rules)).toBeNull();
  });
  it('computes percentiles', () => expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10));
});

import { StressConfig, botLevels, botSchedule, classifyFailurePattern, detectBreakingPoint, evaluateRecovery, latencyDrift, type LevelStats, type StepStats } from '@siteguard/contracts';
import { datasetPath, validateJourney, validateStressPlan } from './index';

const stressTarget = { ...target, stressAuthorized: true, stressMaxBots: 64, stressMaxRps: 100, stressMaxDurationSec: 600, stressMaxRequests: 50_000 };
const stressCfg = (over: object = {}) => StressConfig.parse({ hypothesis: 'p95 stays under 500ms', mix: [{ paths: ['/'] }], ...over });

describe('bot schedule', () => {
  it('multiplies per interval and caps at maxBots', () => {
    expect(botLevels(stressCfg({ startBots: 1, maxBots: 20 }))).toEqual([1, 2, 4, 8, 16, 20]);
  });
  it('adds a fixed amount per interval', () => {
    expect(botLevels(stressCfg({ startBots: 5, maxBots: 20, growth: { mode: 'add', amount: 5, factor: 2 } }))).toEqual([5, 10, 15, 20]);
  });
  it('appends a recovery stage', () => {
    const stages = botSchedule(stressCfg({ startBots: 2, maxBots: 8 }));
    expect(stages.map((s) => s.phase)).toEqual(['ramp', 'ramp', 'peak', 'recovery']);
    expect(stages.at(-1)!.bots).toBe(1);
  });
});

describe('stress plan', () => {
  it('is refused unless the target opted in', () => {
    expect(() => validateStressPlan(stressCfg(), { ...stressTarget, stressAuthorized: false })).toThrow(/authorised/);
  });
  it('rejects bot counts above the stress ceiling', () => {
    expect(() => validateStressPlan(stressCfg({ maxBots: 100 }), stressTarget)).toThrow(/ceiling/);
  });
  it('rejects schedules longer than the duration limit', () => {
    expect(() => validateStressPlan(stressCfg({ startBots: 1, maxBots: 64, intervalSec: 300 }), stressTarget)).toThrow(/stress limit/);
  });
  it('paces bots so the req/s ceiling holds by construction', () => {
    const plan = validateStressPlan(stressCfg({ maxBots: 50 }), stressTarget);
    expect(plan.gapMs).toBe(500); // 50 bots * 1000 / 100 rps
    expect(plan.maxPossibleRps).toBeLessThanOrEqual(100);
  });
  it('rejects plans estimated over the request budget', () => {
    expect(() => validateStressPlan(stressCfg({ maxBots: 50 }), { ...stressTarget, stressMaxRequests: 100 })).toThrow(/budget/);
  });
});

describe('journeys', () => {
  const journey = (steps: object[]) => ({ name: 'j', steps: steps.map((s) => ({ name: 's', method: 'GET', headers: {}, bodyType: 'none', body: '', extract: [], checks: [], thinkMs: 0, kind: 'normal', ...s })) }) as never;
  it('accepts in-scope steps with extracted variables', async () => {
    await expect(validateJourney(journey([
      { name: 'login', path: '/login', extract: [{ var: 'token', from: 'json', expr: 'token' }] },
      { name: 'cart', path: '/cart?t={{token}}' },
    ]), target)).resolves.toBeUndefined();
  });
  it('rejects variables used before they are extracted', async () => {
    await expect(validateJourney(journey([{ path: '/cart?t={{token}}' }]), target)).rejects.toThrow(/before an earlier step/);
  });
  it('rejects protocol-relative paths that would change host', async () => {
    await expect(validateJourney(journey([{ path: '//evil.com/x' }]), target)).rejects.toThrow(SafetyError);
  });
  it('only allows SG_ environment variables', async () => {
    await expect(validateJourney(journey([{ path: '/x', headers: { a: '{{env.HOME}}' } }]), target)).rejects.toThrow(/SG_/);
    await expect(validateJourney(journey([{ path: '/x', headers: { a: '{{env.SG_TOKEN}}' } }]), target)).resolves.toBeUndefined();
  });
  it('requires a dataset for data references', async () => {
    await expect(validateJourney(journey([{ path: '/u/{{data.id}}' }]), target)).rejects.toThrow(/dataset/);
    await expect(validateJourney(journey([{ path: '/u/{{data.id}}' }]), target, { hasDataset: true })).resolves.toBeUndefined();
  });
});

describe('dataset path', () => {
  it('stays inside the datasets folder', () => {
    expect(datasetPath('/srv/datasets', 'users.json')).toBe('/srv/datasets/users.json');
    expect(() => datasetPath('/srv/datasets', '../etc/passwd')).toThrow(SafetyError);
    expect(() => datasetPath('/srv/datasets', '.hidden')).toThrow(SafetyError);
  });
});

const level = (bots: number, rps: number, p95: number, errorRate = 0, requests = 100): LevelStats => ({ bots, rps, p50: p95 / 2, p95, p99: p95 * 1.2, errorRate, requests });

describe('breaking point', () => {
  it('finds the hockey-stick jump', () => {
    const bp = detectBreakingPoint([level(2, 20, 40), level(4, 40, 45), level(8, 80, 50), level(16, 90, 900)]);
    expect(bp?.bots).toBe(16);
    expect(bp?.kind).toBe('latency');
  });
  it('finds errors-first failures', () => {
    const levels = [level(2, 20, 40), level(4, 40, 45), level(8, 70, 55, 0.2)];
    const bp = detectBreakingPoint(levels);
    expect(bp?.kind).toBe('errors');
    expect(classifyFailurePattern(levels, [], bp)[0]?.pattern).toBe('errors-first');
  });
  it('returns null for a healthy, smoothly levelling curve', () => {
    expect(detectBreakingPoint([level(2, 20, 40), level(4, 38, 44), level(8, 60, 50), level(16, 66, 58)])).toBeNull();
  });
  it('ignores levels with too few requests', () => {
    expect(detectBreakingPoint([level(2, 20, 40), level(4, 5, 4000, 0.9, 3)])).toBeNull();
  });
  it('labels a hockey stick', () => {
    const levels = [level(2, 20, 40), level(4, 40, 45), level(8, 80, 50), level(16, 90, 900)];
    expect(classifyFailurePattern(levels, [], detectBreakingPoint(levels))[0]?.pattern).toBe('hockey-stick');
  });
  it('spots partial failure when only one step breaks', () => {
    const step = (name: string, errorRate: number): StepStats => ({ journey: 'j', step: name, requests: 100, p50: 10, p95: 20, p99: 30, errorRate, statusCounts: {} });
    const out = classifyFailurePattern([], [step('search', 0), step('checkout', 0.6)], null);
    expect(out[0]?.pattern).toBe('partial-failure');
    expect(out[0]?.message).toContain('checkout');
  });
});

describe('recovery and drift', () => {
  const pts = (rows: [number, number, number][]) => rows.map(([t, p95, errorRate]) => ({ t, p95, errorRate, requests: 30 }));
  it('reports recovery time', () => {
    const r = evaluateRecovery(pts([[0, 900, 0.3], [5, 400, 0.1], [10, 60, 0], [15, 55, 0], [20, 52, 0]]), 50);
    expect(r).toMatchObject({ recovered: true, secondsToBaseline: 10 });
  });
  it('reports a site that never recovers', () => {
    const r = evaluateRecovery(pts([[0, 900, 0.3], [5, 800, 0.2], [10, 850, 0.25], [15, 900, 0.3]]), 50);
    expect(r.recovered).toBe(false);
    expect(r.residualErrorRate).toBeGreaterThan(0.2);
  });
  it('measures latency drift over a soak', () => {
    expect(latencyDrift([50, 50, 51, 52, 60, 70, 85, 100])).toBeGreaterThan(0.5);
    expect(latencyDrift([50, 51, 50, 52, 50, 51, 50, 52])).toBeLessThan(0.1);
  });
});
