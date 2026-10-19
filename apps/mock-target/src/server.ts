// A small, deliberately imperfect website to practise on. It is NOT secure on purpose:
// missing headers, a loose cookie, broken links, a redirect, a slow page and a flaky endpoint.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const page = (title: string | null, desc: string | null, body: string) =>
  `<!doctype html><html><head>${title ? `<title>${title}</title>` : ''}${desc ? `<meta name="description" content="${desc}">` : ''}</head><body>${body}</body></html>`;

const nav = `<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/products">Products</a> <a href="/slow">Slow</a> <a href="/old-page">Old page</a> <a href="/gone">Gone</a> <a href="/spa">SPA</a></nav>`;

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
