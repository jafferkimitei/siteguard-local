import { randomUUID } from 'node:crypto';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { reportsDir } from '@siteguard/database';
import { isCancelled, redis, sleep } from './common';

/** Scratch directory under reports/.work. World-writable because tool containers run as an unprivileged user. */
export function makeWorkDir(name: string) {
  const dir = join(reportsDir, '.work', name);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o777);
  return dir;
}

export const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true });

export const killContainer = (name: string) => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });

/**
 * Runs `fn` while holding an exclusive Redis lock, waiting its turn if another run holds it.
 * Used only where two concurrent runs would otherwise collide on a real resource (e.g. the ZAP
 * Docker container's fixed proxy port) — not a general "one run at a time" mechanism.
 */
export async function withLock<T>(
  key: string,
  runId: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; onWaiting?: () => Promise<void> } = {},
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const token = randomUUID();
  let waited = false;
  for (;;) {
    if (await isCancelled(runId)) throw new Error('Cancelled while waiting for a lock');
    const got = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (got === 'OK') break;
    if (!waited) {
      waited = true;
      await opts.onWaiting?.();
    }
    await sleep(1000);
  }
  // Renew periodically so a slow run (e.g. a full active scan) doesn't lose the lock mid-run.
  const renew = setInterval(() => void redis.pexpire(key, ttlMs).catch(() => undefined), Math.floor(ttlMs / 2));
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    // Only release if we still hold it (avoids releasing a lock another waiter has since acquired after a TTL expiry).
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token).catch(() => undefined);
  }
}

/** Track a child's exit code (null while running) and the tail of its stderr. */
export function watchChild(child: ChildProcess, stderrBytes = 2000) {
  let stderr = '';
  let exit: number | null = null;
  child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-stderrBytes)));
  child.on('exit', (code) => (exit = code ?? -1));
  child.on('error', (e) => {
    stderr += `\nspawn error: ${e.message}`;
    exit = -1;
  });
  return { exitCode: () => exit as number | null, stderr: () => stderr };
}
