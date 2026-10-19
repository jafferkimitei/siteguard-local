import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import {
  DATA_REF, ENV_REF, HARD_MAX_BROWSER_BOTS, botSchedule, estimateRequests, estimateStressRequests, minGapMs, scheduleStats, stepRefs,
  type JourneyInput, type LoadConfig, type Stage, type StopRules, type StressConfig,
} from '@siteguard/contracts';

export { estimateRequests };

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyError';
  }
}

/** The slice of a Target the safety layer needs. */
export interface TargetPolicy {
  baseUrl: string;
  extraHosts: string[];
  allowPrivateNetwork: boolean;
  maxRps: number;
  maxDurationSec: number;
  maxRequests: number;
}

// ---------------- IP classification ----------------

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** Cloud metadata endpoints are blocked for every target, even with allowPrivateNetwork. */
export function isMetadataIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) return isMetadataIp(lower.slice(7));
  if (isIP(ip) === 4) return inCidr4(ip, '169.254.0.0', 16); // link-local incl. 169.254.169.254
  return lower === 'fd00:ec2::254' || lower.startsWith('fe80:');
}

export function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
  if (isIP(ip) === 4) {
    return (
      inCidr4(ip, '10.0.0.0', 8) ||
      inCidr4(ip, '172.16.0.0', 12) ||
      inCidr4(ip, '192.168.0.0', 16) ||
      inCidr4(ip, '127.0.0.0', 8) ||
      inCidr4(ip, '0.0.0.0', 8) ||
      inCidr4(ip, '100.64.0.0', 10) ||
      isMetadataIp(ip)
    );
  }
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

// ---------------- Scope ----------------

export function allowedHosts(target: Pick<TargetPolicy, 'baseUrl' | 'extraHosts'>): Set<string> {
  const hosts = new Set<string>([new URL(target.baseUrl).hostname.toLowerCase()]);
  for (const h of target.extraHosts) hosts.add(h.toLowerCase());
  return hosts;
}

export function isInScope(url: string, target: Pick<TargetPolicy, 'baseUrl' | 'extraHosts'>): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return allowedHosts(target).has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Resolve the URL's host and make sure every address is acceptable.
 * Throws SafetyError otherwise. Call before issuing any request to a URL.
 */
export async function assertDestinationAllowed(
  url: string,
  target: Pick<TargetPolicy, 'baseUrl' | 'extraHosts' | 'allowPrivateNetwork'>,
): Promise<void> {
  if (!isInScope(url, target)) throw new SafetyError(`${url} is outside the approved scope of this target`);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.length === 0) throw new SafetyError(`Could not resolve ${host}`);
  for (const ip of addrs) {
    if (isMetadataIp(ip)) throw new SafetyError(`${host} resolves to a blocked metadata/link-local address (${ip})`);
    if (isPrivateIp(ip) && !target.allowPrivateNetwork) {
      throw new SafetyError(
        `${host} resolves to a private/loopback address (${ip}). Enable "allow private network" on the target if this is your own dev server.`,
      );
    }
  }
}

// ---------------- Load limits ----------------

export interface PlannedLoad {
  rps: number;
  durationSec: number;
  rampUpSec: number;
  /** Upper bound on requests the arrival-rate profile will generate. */
  estimatedRequests: number;
}

/** Reject (never silently clamp) configs that exceed the target's ceilings. */
export function validateLoadPlan(cfg: LoadConfig, target: TargetPolicy): PlannedLoad {
  if (cfg.rps > target.maxRps) throw new SafetyError(`Requested ${cfg.rps} req/s exceeds this target's ceiling of ${target.maxRps} req/s`);
  if (cfg.durationSec > target.maxDurationSec)
    throw new SafetyError(`Requested ${cfg.durationSec}s exceeds this target's limit of ${target.maxDurationSec}s`);
  if (cfg.rampUpSec > cfg.durationSec) throw new SafetyError('Ramp-up cannot be longer than the total duration');
  const estimatedRequests = estimateRequests(cfg.rps, cfg.durationSec, cfg.rampUpSec);
  if (estimatedRequests > target.maxRequests)
    throw new SafetyError(`This plan sends ~${estimatedRequests} requests, over the target's budget of ${target.maxRequests}`);
  return { rps: cfg.rps, durationSec: cfg.durationSec, rampUpSec: cfg.rampUpSec, estimatedRequests };
}

// ---------------- Stop rules ----------------

export interface WindowStats {
  requests: number;
  errorRate: number;
  p95: number;
}

/** Returns a reason string when the test should be aborted, else null. */
export function evaluateStopRules(stats: WindowStats, rules: StopRules, minSamples = 20): string | null {
  if (stats.requests < minSamples) return null;
  if (stats.errorRate > rules.maxErrorRate)
    return `Error rate ${(stats.errorRate * 100).toFixed(1)}% exceeded the ${(rules.maxErrorRate * 100).toFixed(0)}% threshold`;
  if (stats.p95 > rules.maxP95Ms) return `p95 latency ${Math.round(stats.p95)}ms exceeded the ${rules.maxP95Ms}ms threshold`;
  return null;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

// ---------------- Stress limits ----------------

export interface StressTargetPolicy extends TargetPolicy {
  stressAuthorized: boolean;
  stressMaxBots: number;
  stressMaxRps: number;
  stressMaxDurationSec: number;
  stressMaxRequests: number;
}

export interface PlannedStress {
  stages: Stage[];
  durationSec: number;
  peakBots: number;
  /** Pause every bot takes after each request so the req/s ceiling holds by construction. */
  gapMs: number;
  estimatedRequests: number;
  /** Peak throughput the pacing allows; when reached, a plateau is the ceiling, not the server. */
  maxPossibleRps: number;
}

/** Reject (never clamp) stress plans that are unauthorised or exceed the target's stress ceilings. */
export function validateStressPlan(cfg: StressConfig, target: StressTargetPolicy): PlannedStress {
  if (!target.stressAuthorized)
    throw new SafetyError('Stress tests require this target to be marked "stress tests authorised" (a separate opt-in from normal load tests)');
  if (cfg.maxBots > target.stressMaxBots) throw new SafetyError(`Max bots ${cfg.maxBots} exceeds this target's stress ceiling of ${target.stressMaxBots}`);
  if (cfg.profile === 'quick' && cfg.concurrency > target.stressMaxBots)
    throw new SafetyError(`Concurrency ${cfg.concurrency} exceeds this target's stress ceiling of ${target.stressMaxBots} bots`);
  if (cfg.startBots > cfg.maxBots) throw new SafetyError('Start bots cannot be higher than max bots');
  if (cfg.engine === 'hybrid' && cfg.browserBots > HARD_MAX_BROWSER_BOTS) throw new SafetyError(`Browser bots are capped at ${HARD_MAX_BROWSER_BOTS}`);
  const stages = botSchedule(cfg);
  const { durationSec, peakBots } = scheduleStats(stages);
  if (cfg.profile !== 'quick' && durationSec > target.stressMaxDurationSec)
    throw new SafetyError(`The bot schedule runs ${durationSec}s, over this target's stress limit of ${target.stressMaxDurationSec}s`);
  if (cfg.profile === 'quick' && cfg.requests > target.stressMaxRequests)
    throw new SafetyError(`${cfg.requests} requests exceeds this target's stress budget of ${target.stressMaxRequests}`);
  const bots = cfg.profile === 'quick' ? cfg.concurrency : peakBots;
  const gapMs = minGapMs(bots, target.stressMaxRps);
  const estimatedRequests = estimateStressRequests(cfg, target.stressMaxRps);
  if (estimatedRequests > target.stressMaxRequests)
    throw new SafetyError(`This plan can send ~${estimatedRequests} requests, over the target's stress budget of ${target.stressMaxRequests}`);
  const maxPossibleRps = gapMs > 0 ? Math.floor((1000 * bots) / gapMs) : target.stressMaxRps;
  return { stages, durationSec, peakBots: bots, gapMs, estimatedRequests, maxPossibleRps };
}

/** Throws if any journey step could leave the approved scope or reference something it should not. */
export async function validateJourney(journey: JourneyInput, target: TargetPolicy, opts: { hasDataset?: boolean } = {}): Promise<void> {
  const declared = new Set<string>();
  for (const [i, step] of journey.steps.entries()) {
    for (const ref of stepRefs(step)) {
      if (ENV_REF.test(ref)) continue;
      const data = DATA_REF.exec(ref);
      if (data) {
        if (!opts.hasDataset) throw new SafetyError(`Step "${step.name}" uses {{${ref}}} but the run has no dataset selected`);
        continue;
      }
      if (ref.startsWith('env.')) throw new SafetyError(`Step "${step.name}": {{${ref}}} is not allowed; only variables named SG_... can be read from the environment`);
      if (!declared.has(ref)) throw new SafetyError(`Step "${step.name}" (#${i + 1}) uses {{${ref}}} before an earlier step extracts it`);
    }
    for (const e of step.extract) declared.add(e.var);
    // Substitute placeholders, then make sure the path still lands on an approved host.
    const probe = step.path.replace(/\{\{[^}]*\}\}/g, 'x');
    if (probe.startsWith('//') || !probe.startsWith('/')) throw new SafetyError(`Step "${step.name}": path must be a single-slash relative path`);
    await assertDestinationAllowed(new URL(probe, target.baseUrl).toString(), target);
  }
}

/** Bots-per-level and breaking-point helpers live in contracts; this guards the dataset file name. */
export function datasetPath(root: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name) || name.startsWith('.')) throw new SafetyError('Invalid dataset name');
  const full = resolve(root, name);
  if (dirname(full) !== resolve(root)) throw new SafetyError('Dataset must live directly inside the datasets folder');
  return full;
}
