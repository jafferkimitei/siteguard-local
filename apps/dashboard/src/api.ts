export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.issues?.map((i: any) => `${i.path}: ${i.message}`).join('; ');
    throw new Error(detail || data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export type RunType = 'LOAD' | 'CRAWL' | 'SECURITY';
export interface Target {
  id: string; name: string; baseUrl: string; extraHosts: string[]; allowPrivateNetwork: boolean;
  activeScanAuthorized: boolean; maxRps: number; maxDurationSec: number; maxRequests: number;
}
export interface Run {
  id: string; targetId: string; type: RunType; status: string; config: any; summary: any; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; target?: Partial<Target>;
}
export interface Finding {
  id: string; runId: string; targetId: string; source: string; severity: string; title: string; description: string;
  evidence: string | null; remediation: string | null; url: string | null; status: string; createdAt: string; target?: { name: string };
}
export interface Metric { ts: string; rps: number; p50: number; p95: number; p99: number; errorRate: number; vus: number; requests: number }

/** Mirrors safety.estimateRequests (kept local so the browser bundle doesn't pull in node:dns). */
export const estimateRequests = (rps: number, dur: number, ramp: number) => {
  const r = Math.min(ramp, dur);
  return Math.ceil((rps * r) / 2 + rps * (dur - r));
};
