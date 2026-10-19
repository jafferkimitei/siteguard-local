import { z } from 'zod';

// ---- Safe defaults / hard ceilings (the backend enforces these, the UI only mirrors them) ----
export const DEFAULT_MAX_RPS = 5;
export const DEFAULT_MAX_DURATION_SEC = 120;
export const DEFAULT_MAX_REQUESTS = 5000;
export const HARD_MAX_RPS = 200;
export const HARD_MAX_DURATION_SEC = 1800;
export const HARD_MAX_REQUESTS = 500_000;
export const HARD_MAX_VUS = 200;

export const StopRules = z.object({
  /** Abort when the error rate over the last window exceeds this (0..1). */
  maxErrorRate: z.number().min(0).max(1).default(0.5),
  /** Abort when p95 latency over the last window exceeds this many ms. */
  maxP95Ms: z.number().int().min(10).max(120_000).default(10_000),
});
export type StopRules = z.infer<typeof StopRules>;

// ---- Stress ceilings (per-target values are capped by these) ----
export const HARD_MAX_STRESS_BOTS = 2000;
export const HARD_MAX_BROWSER_BOTS = 20;
export const HARD_MAX_STRESS_RPS = 5000;
export const HARD_MAX_STRESS_DURATION_SEC = 3600;
export const HARD_MAX_STRESS_REQUESTS = 5_000_000;
