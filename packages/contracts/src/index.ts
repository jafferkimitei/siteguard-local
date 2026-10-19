import { z } from 'zod';

export const RunType = z.enum(['LOAD', 'CRAWL', 'SECURITY']);
export type RunType = z.infer<typeof RunType>;

export const RunStatus = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABORTED']);
export type RunStatus = z.infer<typeof RunStatus>;

export const Severity = z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type Severity = z.infer<typeof Severity>;

export const FindingStatus = z.enum(['OPEN', 'FIXED', 'IGNORED']);
export type FindingStatus = z.infer<typeof FindingStatus>;

// ---- Safe defaults / hard ceilings (the backend enforces these, the UI only mirrors them) ----
export const DEFAULT_MAX_RPS = 5;
export const DEFAULT_MAX_DURATION_SEC = 120;
export const DEFAULT_MAX_REQUESTS = 5000;
export const HARD_MAX_RPS = 200;
export const HARD_MAX_DURATION_SEC = 1800;
export const HARD_MAX_REQUESTS = 500_000;
export const HARD_MAX_VUS = 200;

// ---- Targets ----
export const TargetInput = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.url().refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are allowed'),
  /** Extra hostnames (besides the base URL host) that crawling may follow. */
  extraHosts: z.array(z.string().trim().toLowerCase().min(1)).max(20).default([]),
  /** Must be ticked for localhost / private-network targets (e.g. your dev server). */
  allowPrivateNetwork: z.boolean().default(false),
  /** Confirms you own this target and active (intrusive) scans are permitted. */
  activeScanAuthorized: z.boolean().default(false),
  maxRps: z.number().int().min(1).max(HARD_MAX_RPS).default(DEFAULT_MAX_RPS),
  maxDurationSec: z.number().int().min(5).max(HARD_MAX_DURATION_SEC).default(DEFAULT_MAX_DURATION_SEC),
  maxRequests: z.number().int().min(10).max(HARD_MAX_REQUESTS).default(DEFAULT_MAX_REQUESTS),
});
export type TargetInput = z.infer<typeof TargetInput>;
export const TargetPatch = TargetInput.partial();

// ---- Run configs ----
export const StopRules = z.object({
  /** Abort when the error rate over the last window exceeds this (0..1). */
  maxErrorRate: z.number().min(0).max(1).default(0.5),
  /** Abort when p95 latency over the last window exceeds this many ms. */
  maxP95Ms: z.number().int().min(10).max(120_000).default(10_000),
});
export type StopRules = z.infer<typeof StopRules>;

export const LoadConfig = z.object({
  paths: z.array(z.string().startsWith('/')).min(1).max(50).default(['/']),
  /** Requests-per-second the test ramps up to. Clamped by the target ceiling. */
  rps: z.number().int().min(1).max(HARD_MAX_RPS).default(1),
  /** Upper bound on concurrent virtual users. */
  maxVus: z.number().int().min(1).max(HARD_MAX_VUS).default(10),
  durationSec: z.number().int().min(5).max(HARD_MAX_DURATION_SEC).default(30),
  rampUpSec: z.number().int().min(0).max(HARD_MAX_DURATION_SEC).default(5),
  stopRules: StopRules.default({ maxErrorRate: 0.5, maxP95Ms: 10_000 }),
});
export type LoadConfig = z.infer<typeof LoadConfig>;

export const CrawlConfig = z.object({
  startPath: z.string().startsWith('/').default('/'),
  maxPages: z.number().int().min(1).max(1000).default(50),
  maxDepth: z.number().int().min(0).max(10).default(3),
  /** Requests per second ceiling for the crawler. */
  rps: z.number().int().min(1).max(20).default(2),
  /** Render pages in headless Chromium (Playwright) so JavaScript-created links and metadata are seen. */
  renderJs: z.boolean().default(false),
});
export type CrawlConfig = z.infer<typeof CrawlConfig>;

export const SecurityConfig = z.object({
  /** Built-in passive checks (headers, cookies, TLS, exposed files). Always safe. */
  passive: z.boolean().default(true),
  /** OWASP ZAP baseline (passive spider + scan) via Docker. */
  zapBaseline: z.boolean().default(false),
  /** ZAP active scan. Requires target.activeScanAuthorized. */
  zapActive: z.boolean().default(false),
});
export type SecurityConfig = z.infer<typeof SecurityConfig>;

export const CreateRun = z.discriminatedUnion('type', [
  z.object({ type: z.literal('LOAD'), targetId: z.string().min(1), config: LoadConfig.default(LoadConfig.parse({})) }),
  z.object({ type: z.literal('CRAWL'), targetId: z.string().min(1), config: CrawlConfig.default(CrawlConfig.parse({})) }),
  z.object({ type: z.literal('SECURITY'), targetId: z.string().min(1), config: SecurityConfig.default(SecurityConfig.parse({})) }),
]);
export type CreateRun = z.infer<typeof CreateRun>;

// ---- Live metrics ----
export interface MetricPointDTO {
  ts: string;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  vus: number;
  requests: number;
}

export interface LoadSummary {
  totalRequests: number;
  failedRequests: number;
  errorRate: number;
  avgRps: number;
  peakRps: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  statusCounts: Record<string, number>;
  durationSec: number;
  abortReason?: string;
}

export interface CrawlSummary {
  pagesCrawled: number;
  brokenLinks: number;
  redirects: number;
  missingTitle: number;
  missingDescription: number;
  avgLoadMs: number;
}

export interface SecuritySummary {
  findings: number;
  bySeverity: Record<string, number>;
  checks: string[];
}

/** Channel messages published by workers and relayed to the dashboard via SSE. */
export type RunEvent =
  | { kind: 'status'; status: RunStatus; error?: string }
  | { kind: 'metric'; point: MetricPointDTO }
  | { kind: 'progress'; message: string; done?: number; total?: number }
  | { kind: 'finding'; title: string; severity: Severity };

export const runChannel = (runId: string) => `siteguard:run:${runId}`;
export const cancelKey = (runId: string) => `siteguard:cancel:${runId}`;
export const QUEUE_NAME = 'siteguard-runs';
export interface RunJobData { runId: string }
