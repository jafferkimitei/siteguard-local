// A small, deliberately imperfect website to practise on. It is NOT secure on purpose:
// missing headers, a loose cookie, broken links, a redirect, a slow page and a flaky endpoint.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const page = (title: string | null, desc: string | null, body: string) =>
  `<!doctype html><html><head>${title ? `<title>${title}</title>` : ''}${desc ? `<meta name="description" content="${desc}">` : ''}</head><body>${body}</body></html>`;

const nav = `<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/products">Products</a> <a href="/slow">Slow</a> <a href="/old-page">Old page</a> <a href="/gone">Gone</a> <a href="/spa">SPA</a></nav>`;

// ---- Shop journey with load-dependent weaknesses (for stress testing) ----
// pool: a small fake DB connection pool. Past POOL_SIZE concurrent queries, requests queue and slow down.
// overload: above HARD_LIMIT concurrent requests the server sheds load with 503.
const POOL_SIZE = Number(process.env.MOCK_POOL ?? 8);
const HARD_LIMIT = Number(process.env.MOCK_HARD_LIMIT ?? 60);
let inFlight = 0;
let dbBusy = 0;
let overloadedUntil = 0;
const leak: string[] = []; // grows on every /search: latency drifts up during a soak
const sessions = new Map<string, { user: string; cart: string[] }>();
let orders = 0;
let uniqueOrders = 0;

async function dbQuery(ms: number) {
  dbBusy++;
  // beyond the pool every extra concurrent query waits in line, so latency climbs like a hockey stick
  const queue = Math.max(0, dbBusy - POOL_SIZE);
  await sleep(ms + queue * 25);
  dbBusy--;
}

const cookieOf = (req: { headers: Record<string, string | string[] | undefined> }) => /sid=([a-z0-9]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
const readBody = (req: AsyncIterable<Buffer>) => (async () => { let b = ''; for await (const c of req) b += c; return b; })();

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const send = (status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      'content-type': type,
      server: 'nginx/1.14.0',
      'x-powered-by': 'Express',
      ...extra,
    });
    res.end(body);
  };

  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => send(status, JSON.stringify(body), 'application/json', extra);
  if (url.pathname.startsWith('/shop/')) {
    inFlight++;
    res.on('close', () => { inFlight--; });
    try {
      if (inFlight > HARD_LIMIT || Date.now() < overloadedUntil) {
        if (inFlight > HARD_LIMIT) overloadedUntil = Date.now() + 8000; // stays unhealthy for a while after a spike (slow recovery)
        return json(503, { error: 'overloaded' }, { 'retry-after': '1' });
      }
      const sid = cookieOf(req);
      const sess = sid ? sessions.get(sid) : undefined;
      switch (url.pathname) {
        case '/shop/login': {
          if (req.method === 'GET') return json(200, { csrf: 'tok-' + Math.random().toString(36).slice(2, 8) });
          const form = new URLSearchParams(await readBody(req));
          await dbQuery(15);
          const user = form.get('user');
          if (!user || !String(form.get('csrf')).startsWith('tok-')) return json(401, { error: 'bad login' });
          const id = Math.random().toString(36).slice(2, 12);
          sessions.set(id, { user, cart: [] });
          return json(200, { ok: true, user }, { 'set-cookie': `sid=${id}; Path=/; HttpOnly` });
        }
        case '/shop/search': {
          leak.push('x'.repeat(2000)); // slow memory leak
          await dbQuery(20 + Math.min(leak.length / 500, 80));
          const q = url.searchParams.get('q') ?? '';
          return json(200, { q, results: [{ id: 'p1', name: 'Widget' }, { id: 'p2', name: 'Gadget' }] });
        }
        case '/shop/cart/add': {
          if (!sess) return json(401, { error: 'login first' });
          const form = new URLSearchParams(await readBody(req));
          await dbQuery(15);
          sess.cart.push(form.get('item') ?? 'p1');
          return json(200, { cartId: 'cart-' + sess.cart.length, items: sess.cart.length });
        }
        case '/shop/checkout': {
          if (!sess) return json(401, { error: 'login first' });
          await dbQuery(30);
          // checkout alone depends on a flaky "payment" service that times out when the server is busy
          if (dbBusy > POOL_SIZE) { await sleep(1500); return json(504, { error: 'payment gateway timeout' }); }
          orders++;
          if (Math.random() > 0.03) uniqueOrders++; // ~3% of orders are duplicated under concurrency
          return json(200, { ok: true, orderNumber: orders });
        }
        case '/shop/orders/count':
          return json(200, { orders, unique: uniqueOrders });
        default:
          return json(404, { error: 'not found' });
      }
    } catch (err) {
      return json(500, { error: String(err) });
    }
  }

  switch (url.pathname) {
    case '/':
      return send(200, page('Mock Shop', 'A practice site for SiteGuard Local', `${nav}<h1>Mock Shop</h1><p>Hello.</p>`), undefined, {
        'set-cookie': 'session=abc123; Path=/',
      });
    case '/about':
      return send(200, page(null, null, `${nav}<h1>About</h1><a href="/contact">Contact</a>`));
    case '/contact':
      return send(200, page('Contact', 'Get in touch', `${nav}<h1>Contact</h1><form action="/contact" method="post"><input type="password" name="p"></form>`));
    case '/products':
      return send(200, page('Products', 'All products', `${nav}<h1>Products</h1>${[1, 2, 3].map((i) => `<a href="/products/${i}">P${i}</a>`).join(' ')}<a href="/products/99">Discontinued</a>`));
    case '/spa': // links and title exist only after JavaScript runs
      return send(200, `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script>document.title='SPA page';document.getElementById('app').innerHTML='<h1>SPA</h1><a href="/js-only">JS-only page</a>';</script></body></html>`);
    case '/js-only':
      return send(200, page('JS-only page', 'Only reachable via JavaScript', `${nav}<h1>JS-only</h1>`));
    case '/slow':
      await sleep(400);
      return send(200, page('Slow page', 'Intentionally slow', `${nav}<h1>Slow</h1>`));
    case '/old-page':
      return send(301, '', 'text/plain', { location: '/about' });
    case '/flaky':
      return Math.random() < 0.2 ? send(500, 'Internal error', 'text/plain') : send(200, 'ok', 'text/plain');
    case '/api/health':
      return send(200, JSON.stringify({ ok: true }), 'application/json', { 'access-control-allow-origin': '*' });
    case '/.git/HEAD': // fake leak so the exposed-file check has something to find
      return send(200, 'ref: refs/heads/main\n', 'text/plain');
    default: {
      const m = /^\/products\/(\d+)$/.exec(url.pathname);
      if (m && Number(m[1]) <= 3) return send(200, page(`Product ${m[1]}`, `Product number ${m[1]}`, `${nav}<h1>Product ${m[1]}</h1>`));
      return send(404, page('Not found', null, 'Not found'));
    }
  }
}).listen(PORT, '127.0.0.1', () => console.log(`mock target listening on http://localhost:${PORT}`));
