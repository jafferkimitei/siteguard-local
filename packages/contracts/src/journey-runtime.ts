import type { JourneyStep } from './stress';

/** Template rendering and value extraction shared by the browser bots and the journey dry-run. (The k6 script carries its own copy: k6 cannot import modules.) */
export type DataRow = Record<string, unknown> | null;
export interface RenderContext {
  vars: Record<string, string>;
  row: DataRow;
  secrets: Record<string, string>;
}

const TOKEN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export function renderTemplate(s: string, ctx: RenderContext, encode: boolean): string {
  return s.replace(TOKEN, (_, k: string) => {
    const v = k.startsWith('env.') ? ctx.secrets[k.slice(4)] : k.startsWith('data.') ? ctx.row?.[k.slice(5)] : ctx.vars[k];
    const text = v === undefined || v === null ? '' : String(v);
    return encode ? encodeURIComponent(text) : text;
  });
}

export const dig = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

export interface StepResponse {
  status: number;
  text: string;
  headers: Record<string, string>;
}

/** Copy extracted values into `vars`; returns the names that were found. */
export function extractInto(step: JourneyStep, res: StepResponse, vars: Record<string, string>): string[] {
  let json: unknown;
  try { json = JSON.parse(res.text); } catch { json = null; }
  const lower = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const found: string[] = [];
  for (const x of step.extract) {
    let val: unknown;
    if (x.from === 'json') val = dig(json, x.expr);
    else if (x.from === 'header') val = lower[x.expr.toLowerCase()];
    else { try { val = new RegExp(x.expr).exec(res.text)?.[1]; } catch { val = undefined; } }
    if (val !== undefined && val !== null) { vars[x.var] = String(val); found.push(x.var); }
  }
  return found;
}

/** Evaluate a step's checks against a response; returns a description for each failed check. */
export function failedChecks(step: JourneyStep, res: StepResponse, ctx: RenderContext): string[] {
  let json: unknown;
  try { json = JSON.parse(res.text); } catch { json = null; }
  const out: string[] = [];
  for (const c of step.checks) {
    if (c.status !== undefined && res.status !== c.status) out.push(`expected status ${c.status}, got ${res.status}`);
    if (c.bodyIncludes && !res.text.includes(renderTemplate(c.bodyIncludes, ctx, false))) out.push(`body does not include "${c.bodyIncludes}"`);
    if (c.equalFields && String(dig(json, c.equalFields[0])) !== String(dig(json, c.equalFields[1]))) out.push(`${c.equalFields[0]} and ${c.equalFields[1]} differ`);
  }
  return out;
}
