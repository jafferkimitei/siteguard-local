/**
 * The script is static: journeys, schedule and pacing arrive as JSON, so no user input is ever
 * spliced into code. Secrets and the dataset are read from files in the work dir.
 */
export function buildStressScript(): string {
  return `import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL.replace(/\\/$/, '');
const CFG = JSON.parse(__ENV.CFG);
const SECRETS = JSON.parse(open(__ENV.SECRETS_FILE));
const DATA = CFG.hasData ? JSON.parse(open(__ENV.DATA_FILE)) : [];
const cacheHit = new Counter('sg_cache_hit');
const cacheMiss = new Counter('sg_cache_miss');
const wafBlock = new Counter('sg_waf_block');

const normal = CFG.journeys.map((j) => ({ ...j, steps: j.steps.filter((s) => s.kind !== 'verify') })).filter((j) => j.steps.length);
const totalWeight = normal.reduce((a, j) => a + j.weight, 0);

function pick() {
  let r = Math.random() * totalWeight;
  for (const j of normal) { r -= j.weight; if (r <= 0) return j; }
  return normal[normal.length - 1];
}

function render(s, vars, row, encode) {
  return s.replace(/\\{\\{\\s*([A-Za-z0-9_.]+)\\s*\\}\\}/g, (_, k) => {
    let v;
    if (k.startsWith('env.')) v = SECRETS[k.slice(4)];
    else if (k.startsWith('data.')) v = row ? row[k.slice(5)] : '';
    else v = vars[k];
    v = v === undefined || v === null ? '' : String(v);
    return encode ? encodeURIComponent(v) : v;
  });
}

function dig(obj, path) {
  return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

function runStep(j, st, vars, row) {
  const headers = {};
  for (const k of Object.keys(st.headers)) headers[k] = render(st.headers[k], vars, row, false);
  let body = null;
  if (st.bodyType === 'json') { body = render(st.body, vars, row, false); headers['Content-Type'] = headers['Content-Type'] || 'application/json'; }
  else if (st.bodyType === 'form') { body = render(st.body, vars, row, true); headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded'; }
  const res = http.request(st.method, BASE + render(st.path, vars, row, true), body, {
    headers,
    redirects: 0,
    tags: { name: st.name, step: st.name, journey: j.name, kind: st.kind },
    responseCallback: http.expectedStatuses({ min: 200, max: 399 }),
  });

  const h = res.headers;
  const cs = (h['Cf-Cache-Status'] || h['X-Cache'] || h['X-Cache-Status'] || '').toUpperCase();
  if (cs.includes('HIT')) cacheHit.add(1); else if (cs.includes('MISS') || cs.includes('EXPIRED') || cs.includes('DYNAMIC')) cacheMiss.add(1);
  if (res.status === 429 || (res.status === 403 && /captcha|challenge|access denied|blocked/i.test(String(res.body || '').slice(0, 2000)))) wafBlock.add(1);

  let json;
  const getJson = () => { if (json === undefined) { try { json = JSON.parse(res.body); } catch (e) { json = null; } } return json; };
  for (const x of st.extract) {
    let val;
    if (x.from === 'json') { const d = getJson(); val = d ? dig(d, x.expr) : undefined; }
    else if (x.from === 'header') val = h[x.expr];
    else { try { const m = new RegExp(x.expr).exec(String(res.body || '')); val = m ? m[1] : undefined; } catch (e) { val = undefined; } }
    if (val !== undefined && val !== null) vars[x.var] = val;
  }
  if (st.checks.length) {
    const checks = {};
    st.checks.forEach((c, i) => {
      if (c.status !== undefined) checks['status is ' + c.status] = (r) => r.status === c.status;
      if (c.bodyIncludes) checks['body includes ' + i] = (r) => String(r.body || '').includes(render(c.bodyIncludes, vars, row, false));
      if (c.equalFields) checks[c.equalFields.join(' = ')] = () => { const d = getJson(); return !!d && String(dig(d, c.equalFields[0])) === String(dig(d, c.equalFields[1])); };
    });
    check(res, checks, { step: st.name, journey: j.name, kind: st.kind });
  }
  sleep(Math.max(st.thinkMs, CFG.gapMs) / 1000);
  return res.status > 0 && res.status < 400;
}

export function load() {
  if (!normal.length) return;
  const j = pick();
  const row = DATA.length ? DATA[(__VU - 1 + __ITER) % DATA.length] : null;
  const vars = {};
  for (const st of j.steps) if (!runStep(j, st, vars, row)) break; // a real user gives up at the first failure
}

export function tail() {
  if (CFG.recoveryBots > 0) load();
}

export function teardown() {
  if (CFG.mode !== 'tail') return;
  for (const j of CFG.journeys) {
    const vars = {};
    for (const st of j.steps) if (st.kind === 'verify') runStep(j, st, vars, null);
  }
}

function scenarios() {
  const common = { gracefulStop: '5s' };
  if (CFG.mode === 'tail') {
    if (CFG.recoveryBots > 0)
      return { tail: { ...common, executor: 'constant-vus', exec: 'tail', vus: CFG.recoveryBots, duration: CFG.recoverySec + 's' } };
    return { tail: { ...common, executor: 'shared-iterations', exec: 'tail', vus: 1, iterations: 1, maxDuration: '1m' } };
  }
  if (CFG.profile === 'quick')
    return { load: { ...common, executor: 'shared-iterations', exec: 'load', vus: CFG.concurrency, iterations: CFG.iterations, maxDuration: '30m' } };
  const stages = [];
  for (const s of CFG.stages) {
    if (s.rampSec > 0) stages.push({ duration: s.rampSec + 's', target: s.bots });
    if (s.durationSec - s.rampSec > 0) stages.push({ duration: (s.durationSec - s.rampSec) + 's', target: s.bots });
  }
  return { load: { ...common, executor: 'ramping-vus', exec: 'load', startVUs: CFG.stages[0].rampSec === 0 ? CFG.stages[0].bots : 0, stages, gracefulRampDown: '0s' } };
}

export const options = {
  discardResponseBodies: false,
  maxRedirects: 0,
  blacklistIPs: JSON.parse(__ENV.BLOCKED),
  userAgent: 'SiteGuardLocal/0.1 (own-site stress test)',
  scenarios: scenarios(),
};

export default function () {}
`;
}

