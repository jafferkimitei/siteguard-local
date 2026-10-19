import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SafetyError } from './index';

/** Resolve a dataset name to a file directly inside the datasets folder (no traversal, no dotfiles). */
export function datasetPath(root: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name) || name.startsWith('.')) throw new SafetyError('Invalid dataset name');
  const full = resolve(root, name);
  if (dirname(full) !== resolve(root)) throw new SafetyError('Dataset must live directly inside the datasets folder');
  return full;
}

function csvToRows(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const split = (l: string) => [...l.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1]!.replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1);
  const header = split(lines[0] ?? '');
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [header[i] ?? `col${i}`, v])));
}

/** Read a dataset from the datasets folder (json array or csv with a header row) and return it as JSON text. */
export function loadDataset(root: string, name: string): string {
  const path = datasetPath(root, name);
  if (!existsSync(path)) throw new SafetyError(`Dataset "${name}" was not found in the datasets/ folder`);
  if (statSync(path).size > 5_000_000) throw new SafetyError('Dataset is larger than 5 MB');
  const text = readFileSync(path, 'utf8');
  const rows = name.toLowerCase().endsWith('.csv') ? csvToRows(text) : JSON.parse(text);
  if (!Array.isArray(rows) || rows.length === 0) throw new SafetyError('Dataset must be a non-empty JSON array or a CSV with a header row');
  return JSON.stringify(rows);
}

