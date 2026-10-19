import { spawn } from 'node:child_process';
import { parseDockerStatsLine, summariseResources, type ResourceSample } from '@siteguard/contracts';
import { sleep } from './common';

/**
 * Samples CPU and memory of a local Docker container once every couple of seconds. This is the one
 * place we get real server-side numbers instead of inferences, and only works for targets you run in Docker.
 */
export function startDockerStats(container: string) {
  let stopped = false;
  const samples: ResourceSample[] = [];
  const sampleOnce = () =>
    new Promise<void>((resolve) => {
      const p = spawn('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', container]);
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve());
      p.on('close', () => {
        const s = parseDockerStatsLine(out.trim().split('\n')[0] ?? '');
        if (s) samples.push(s);
        resolve();
      });
    });
  const loop = (async () => {
    while (!stopped) {
      await sampleOnce();
      await sleep(1000);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return summariseResources(samples);
    },
  };
}
