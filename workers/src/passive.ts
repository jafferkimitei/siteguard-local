import { connect } from 'node:tls';
import * as cheerio from 'cheerio';
import type { Target } from '@siteguard/database';
import { isIP } from 'node:net';
import { isPrivateIp } from '@siteguard/safety';
import { sleep, type FindingInput } from './common';
import { safeFetch } from './http';

const H = (v: string | null) => v?.trim() ?? '';

function headerChecks(url: string, headers: Headers, https: boolean): FindingInput[] {
  const f: FindingInput[] = [];
  const add = (x: Omit<FindingInput, 'source' | 'url'>) => f.push({ source: 'PASSIVE', url, ...x });
  const csp = H(headers.get('content-security-policy'));
  if (!csp) add({ severity: 'MEDIUM', title: 'Missing Content-Security-Policy header',
    description: 'No CSP is set, so the browser has no allow-list for scripts, which makes XSS easier to exploit.',
    remediation: "Add a Content-Security-Policy header, starting with e.g. \"default-src 'self'\" and loosening only as needed." });
  if (!H(headers.get('x-frame-options')) && !/frame-ancestors/i.test(csp)) add({ severity: 'MEDIUM', title: 'Missing clickjacking protection',
    description: 'Neither X-Frame-Options nor a CSP frame-ancestors directive is set, so other sites can embed this page in a frame.',
    remediation: "Send X-Frame-Options: DENY (or SAMEORIGIN), or CSP \"frame-ancestors 'self'\"." });
  if (!/nosniff/i.test(H(headers.get('x-content-type-options')))) add({ severity: 'LOW', title: 'Missing X-Content-Type-Options header',
    description: 'Browsers may MIME-sniff responses and treat them as a different content type.', remediation: 'Send X-Content-Type-Options: nosniff.' });
  if (!H(headers.get('referrer-policy'))) add({ severity: 'LOW', title: 'Missing Referrer-Policy header',
    description: 'Full URLs may leak to other sites through the Referer header.', remediation: 'Send Referrer-Policy: strict-origin-when-cross-origin (or stricter).' });
  if (!H(headers.get('permissions-policy'))) add({ severity: 'INFO', title: 'Missing Permissions-Policy header',
    description: 'Browser features (camera, geolocation, etc.) are not explicitly restricted.', remediation: 'Send a Permissions-Policy header disabling features you do not use.' });
  if (https && !H(headers.get('strict-transport-security'))) add({ severity: 'MEDIUM', title: 'Missing Strict-Transport-Security header',
    description: 'Without HSTS, browsers may connect over plain HTTP first and are open to downgrade attacks.',
    remediation: 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains.' });
  const server = H(headers.get('server'));
  if (/\d/.test(server)) add({ severity: 'LOW', title: 'Server header discloses version', evidence: `Server: ${server}`,
    description: 'The Server header reveals software and version, helping attackers pick known exploits.', remediation: 'Remove the version from the Server header (e.g. `server_tokens off` in nginx).' });
  const powered = H(headers.get('x-powered-by'));
  if (powered) add({ severity: 'LOW', title: 'X-Powered-By header discloses technology', evidence: `X-Powered-By: ${powered}`,
    description: 'This header reveals the application framework.', remediation: 'Remove the header (e.g. `app.disable("x-powered-by")` in Express).' });
  const acao = H(headers.get('access-control-allow-origin'));
  if (acao === '*' && /true/i.test(H(headers.get('access-control-allow-credentials')))) add({ severity: 'HIGH', title: 'CORS allows any origin with credentials',
    evidence: 'Access-Control-Allow-Origin: *\nAccess-Control-Allow-Credentials: true', description: 'Any website could make credentialed requests to this one.',
    remediation: 'Reflect only an allow-list of trusted origins; never combine wildcard origins with credentials.' });
  return f;
}

function cookieChecks(url: string, cookies: string[], https: boolean): FindingInput[] {
  const f: FindingInput[] = [];
  for (const c of cookies) {
    const name = c.split('=')[0]!.trim();
    const flags = c.toLowerCase();
    const sensitive = /sess|auth|token|jwt|sid|login/i.test(name);
    const add = (x: Omit<FindingInput, 'source' | 'url'>) => f.push({ source: 'PASSIVE', url, evidence: `Set-Cookie: ${c.replace(/=[^;]*/, '=<redacted>')}`, ...x });
    if (!flags.includes('httponly')) add({ severity: sensitive ? 'MEDIUM' : 'LOW', title: `Cookie "${name}" missing HttpOnly`,
      description: 'JavaScript can read this cookie, so an XSS bug could steal it.', remediation: 'Set the HttpOnly attribute on cookies that scripts do not need.' });
    if (https && !flags.includes('secure')) add({ severity: sensitive ? 'MEDIUM' : 'LOW', title: `Cookie "${name}" missing Secure`,
      description: 'The cookie may be sent over unencrypted HTTP.', remediation: 'Set the Secure attribute.' });
    if (!flags.includes('samesite')) add({ severity: 'LOW', title: `Cookie "${name}" missing SameSite`,
      description: 'Without SameSite the cookie is sent on cross-site requests, aiding CSRF.', remediation: 'Set SameSite=Lax (or Strict).' });
  }
  return f;
}

async function tlsChecks(target: Target): Promise<FindingInput[]> {
  const u = new URL(target.baseUrl);
  if (u.protocol !== 'https:') return [];
  const url = u.origin;
  return new Promise((resolve) => {
    const f: FindingInput[] = [];
    const sock = connect({ host: u.hostname, port: Number(u.port || 443), servername: isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false, timeout: 10_000 }, () => {
      const proto = sock.getProtocol();
      const cert = sock.getPeerCertificate();
      if (proto && /TLSv1(\.1)?$|SSL/.test(proto)) f.push({ source: 'PASSIVE', severity: 'HIGH', title: `Obsolete TLS version negotiated (${proto})`, url,
        description: 'The server negotiated a deprecated protocol version.', remediation: 'Disable TLS 1.0/1.1; require TLS 1.2 or newer.' });
      if (!sock.authorized) f.push({ source: 'PASSIVE', severity: 'HIGH', title: 'TLS certificate not trusted', url, evidence: String(sock.authorizationError),
        description: 'The certificate failed validation (self-signed, wrong host, or incomplete chain).', remediation: 'Install a certificate from a trusted CA with the full chain.' });
      if (cert?.valid_to) {
        const days = (new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000;
        if (days < 0) f.push({ source: 'PASSIVE', severity: 'HIGH', title: 'TLS certificate expired', url, evidence: `valid_to: ${cert.valid_to}`,
          description: 'The certificate has expired.', remediation: 'Renew the certificate immediately.' });
        else if (days < 14) f.push({ source: 'PASSIVE', severity: 'MEDIUM', title: 'TLS certificate expires soon', url, evidence: `valid_to: ${cert.valid_to} (${Math.floor(days)} days)`,
          description: 'The certificate expires in under two weeks.', remediation: 'Renew it and set up automatic renewal.' });
      }
      sock.end();
      resolve(f);
    });
    sock.on('error', (e) => {
      f.push({ source: 'PASSIVE', severity: 'MEDIUM', title: 'TLS handshake failed', url, evidence: e.message, description: 'Could not complete a TLS handshake.', remediation: 'Check the server certificate and protocol configuration.' });
      resolve(f);
    });
    sock.on('timeout', () => { sock.destroy(); resolve(f); });
  });
}

const PROBES: { path: string; test: RegExp; severity: FindingInput['severity']; title: string; remediation: string }[] = [
  { path: '/.env', test: /^[A-Z][A-Z0-9_]*\s*=/m, severity: 'CRITICAL', title: 'Exposed .env file', remediation: 'Block dotfiles at the web server and rotate every secret that was in the file.' },
  { path: '/.git/HEAD', test: /^ref:\s*refs\//, severity: 'HIGH', title: 'Exposed .git directory', remediation: 'Deny access to /.git and never deploy the repository folder. Rotate any secrets in history.' },
  { path: '/.DS_Store', test: /Bud1/, severity: 'LOW', title: 'Exposed .DS_Store file', remediation: 'Delete .DS_Store files from deployments and block them in the web server.' },
  { path: '/phpinfo.php', test: /phpinfo\(\)|PHP Version/i, severity: 'MEDIUM', title: 'Exposed phpinfo page', remediation: 'Remove phpinfo.php from production.' },
  { path: '/server-status', test: /Apache Server Status/i, severity: 'MEDIUM', title: 'Exposed Apache server-status', remediation: 'Restrict /server-status to localhost.' },
];

export async function runPassiveChecks(target: Target, onStep: (m: string) => Promise<void>): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const origin = new URL(target.baseUrl).origin;
  const https = origin.startsWith('https:');

  await onStep('Fetching start page and inspecting headers');
  const res = await safeFetch(new URL(target.baseUrl).toString(), target);
  findings.push(...headerChecks(origin, res.headers, https), ...cookieChecks(origin, res.setCookies, https));

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html') && res.body) {
    const $ = cheerio.load(res.body);
    if (/<title>\s*Index of \//i.test(res.body)) findings.push({ source: 'PASSIVE', severity: 'MEDIUM', title: 'Directory listing enabled', url: origin,
      description: 'The server lists directory contents.', remediation: 'Disable autoindex / directory browsing.' });
    if (https) {
      const mixed = $('script[src^="http:"], link[href^="http:"][rel="stylesheet"], img[src^="http:"], iframe[src^="http:"]').length;
      if (mixed) findings.push({ source: 'PASSIVE', severity: 'MEDIUM', title: 'Mixed content', url: origin, evidence: `${mixed} insecure resource reference(s)`,
        description: 'The HTTPS page loads resources over plain HTTP.', remediation: 'Load every resource over HTTPS.' });
    }
    const insecurePw = !https && $('input[type="password"]').length > 0;
    if (insecurePw && !isPrivateIp(new URL(origin).hostname)) findings.push({ source: 'PASSIVE', severity: 'HIGH', title: 'Password field served over HTTP', url: origin,
      description: 'Credentials entered here would be sent in clear text.', remediation: 'Serve the whole site over HTTPS.' });
  }
  if (!https && !target.allowPrivateNetwork) findings.push({ source: 'PASSIVE', severity: 'MEDIUM', title: 'Site served over HTTP', url: origin,
    description: 'Traffic is unencrypted and can be read or modified in transit.', remediation: 'Enable HTTPS and redirect all HTTP traffic to it.' });

  await onStep('Checking TLS');
  findings.push(...(await tlsChecks(target)));

  await onStep('Probing for commonly exposed files');
  for (const p of PROBES) {
    try {
      const r = await safeFetch(new URL(p.path, origin).toString(), target, { maxHops: 0, maxBytes: 8192 });
      if (r.status === 200 && p.test.test(r.body)) findings.push({ source: 'PASSIVE', severity: p.severity, title: p.title, url: new URL(p.path, origin).toString(),
        description: `${p.path} is publicly readable and its content matches the expected signature.`, evidence: r.body.slice(0, 80).replace(/=.*/g, '=<redacted>'), remediation: p.remediation });
    } catch { /* unreachable probe path: nothing to report */ }
    await sleep(500); // ≤2 requests/second
  }
  return findings;
}
