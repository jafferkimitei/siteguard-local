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

export type { RunType } from '@siteguard/contracts';
import type { MetricPointDTO, RunType } from '@siteguard/contracts';
export interface Target {
  id: string; name: string; baseUrl: string; extraHosts: string[]; allowPrivateNetwork: boolean;
  activeScanAuthorized: boolean; maxRps: number; maxDurationSec: number; maxRequests: number;
  stressAuthorized: boolean; stressMaxBots: number; stressMaxRps: number; stressMaxDurationSec: number; stressMaxRequests: number; containerName: string | null;
}
export interface Journey { id: string; targetId: string; name: string; steps: import('@siteguard/contracts').JourneyStep[]; warnings?: string[] }
export interface Run {
  id: string; targetId: string; type: RunType; status: string; config: any; summary: any; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; target?: Partial<Target>;
}
export interface Finding {
  id: string; runId: string; targetId: string; source: string; severity: string; title: string; description: string;
  evidence: string | null; remediation: string | null; url: string | null; status: string; createdAt: string; target?: { name: string };
}
export type Metric = MetricPointDTO;

export { estimateRequests } from '@siteguard/contracts';
