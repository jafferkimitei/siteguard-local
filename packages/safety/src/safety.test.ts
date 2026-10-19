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
