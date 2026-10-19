import { assertDestinationAllowed } from '@siteguard/safety';
import type { Target } from '@siteguard/database';

export const USER_AGENT = 'SiteGuardLocal/0.1 (own-site audit)';

export interface Hop {
  url: string;
  status: number;
}

export interface FetchResult {
  finalUrl: string;
  status: number;
  chain: Hop[];
  headers: Headers;
  setCookies: string[];
  body: string;
  ms: number;
  /** Set when a redirect pointed outside the approved scope; we stop instead of following it. */
  blockedRedirect?: string;
  loop?: boolean;
}

/**
 * GET a URL, following redirects manually so that EVERY hop is scope- and
 * network-checked before a request is made.
 */
export async function safeFetch(url: string, target: Target, opts: { maxHops?: number; maxBytes?: number; timeoutMs?: number } = {}): Promise<FetchResult> {
  const maxHops = opts.maxHops ?? 5;
  const chain: Hop[] = [];
  const seen = new Set<string>();
  let current = url;
  const started = Date.now();

  for (let hop = 0; ; hop++) {
    await assertDestinationAllowed(current, target);
    seen.add(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*;q=0.8' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    chain.push({ url: current, status: res.status });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      const next = new URL(location, current).toString();
      const base: Omit<FetchResult, 'body'> = {
        finalUrl: current, status: res.status, chain, headers: res.headers, setCookies: res.headers.getSetCookie(), ms: Date.now() - started,
      };
      if (seen.has(next) || hop >= maxHops) return { ...base, body: '', loop: seen.has(next) };
      try {
        await assertDestinationAllowed(next, target);
      } catch {
        return { ...base, body: '', blockedRedirect: next };
      }
      current = next;
      continue;
    }
    const maxBytes = opts.maxBytes ?? 2_000_000;
    const ct = res.headers.get('content-type') ?? '';
    let body = '';
    if (/text|json|xml/i.test(ct) || ct === '') {
      const buf = Buffer.from(await res.arrayBuffer());
      body = buf.subarray(0, maxBytes).toString('utf8');
    } else {
      await res.body?.cancel();
    }
    return { finalUrl: current, status: res.status, chain, headers: res.headers, setCookies: res.headers.getSetCookie(), body, ms: Date.now() - started };
  }
}
