import { spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { reportsDir } from '@siteguard/database';

/** Scratch directory under reports/.work. World-writable because tool containers run as an unprivileged user. */
export function makeWorkDir(name: string) {
  const dir = join(reportsDir, '.work', name);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o777);
  return dir;
}

export const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true });

export const killContainer = (name: string) => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });

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
