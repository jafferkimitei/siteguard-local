import type { ReactNode } from 'react';
import type { Run } from './api';

export const SEV_COLOR: Record<string, string> = {
  CRITICAL: 'bg-red-600/25 text-red-300', HIGH: 'bg-red-500/20 text-red-300', MEDIUM: 'bg-orange-500/20 text-orange-300',
  LOW: 'bg-yellow-500/15 text-yellow-200', INFO: 'bg-sky-500/15 text-sky-300',
};
const STATUS_COLOR: Record<string, string> = {
  QUEUED: 'bg-zinc-500/20 text-zinc-300', RUNNING: 'bg-blue-500/20 text-blue-300', COMPLETED: 'bg-emerald-500/20 text-emerald-300',
  FAILED: 'bg-red-500/20 text-red-300', CANCELLED: 'bg-zinc-500/20 text-zinc-300', ABORTED: 'bg-orange-500/20 text-orange-300',
};

export const Badge = ({ kind, children }: { kind: string; children?: ReactNode }) => (
  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${SEV_COLOR[kind] ?? STATUS_COLOR[kind] ?? 'bg-zinc-500/20'}`}>{children ?? kind}</span>
);

export const Card = ({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`rounded-lg border border-line bg-panel ${className}`}>
    {title && (
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </header>
    )}
    <div className="p-4">{children}</div>
  </section>
);

export const Stat = ({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) => (
  <div className="rounded-lg border border-line bg-panel px-4 py-3">
    <div className="text-xs text-muted">{label}</div>
    <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    {sub && <div className="text-xs text-muted">{sub}</div>}
  </div>
);

export const Btn = ({ variant = 'primary', className = '', ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) => (
  <button
    {...p}
    className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
      variant === 'primary' ? 'bg-accent text-black hover:brightness-110' : variant === 'danger' ? 'bg-red-600 text-white hover:brightness-110' : 'border border-line hover:bg-white/5'
    } ${className}`}
  />
);

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="block">
    <span className="mb-1 block text-xs text-muted">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
  </label>
);

export const ErrorBox = ({ error }: { error?: string | null }) =>
  error ? <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div> : null;

export const ms = (n?: number) => (n === undefined || n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(n < 10 ? 1 : 0)} ms`);
export const pct = (n?: number) => (n === undefined ? '—' : `${(n * 100).toFixed(n > 0 && n < 0.01 ? 2 : 1)}%`);
export const when = (d?: string | null) => (d ? new Date(d).toLocaleString() : '—');
export const TYPE_LABEL = { LOAD: 'Load test', CRAWL: 'Crawl', SECURITY: 'Security scan', STRESS: 'Stress test' } as const;

/** One-line result text for a run, shared by every run table. */
export const runResult = (r: Pick<Run, 'type' | 'summary' | 'error'>) =>
  !r.summary ? r.error ?? '—'
  : r.type === 'LOAD' ? `p95 ${ms(r.summary.p95)} · ${r.summary.totalRequests} req · ${pct(r.summary.errorRate)} err`
  : r.type === 'STRESS' ? (r.summary.breakingPoint ? `breaks at ${r.summary.breakingPoint.bots} bots · ${r.summary.totalRequests} req` : `no break up to ${r.summary.peakBots} bots · ${r.summary.totalRequests} req`)
  : r.type === 'CRAWL' ? `${r.summary.pagesCrawled} pages · ${r.summary.brokenLinks} broken`
  : `${r.summary.findings} findings`;
