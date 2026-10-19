# SiteGuard Local

A private, local-first toolkit for load-testing, crawling and security-checking **your own** websites.
Dashboard + API + worker all run on your machine; only the traffic you aim at a target leaves it.

## Run it

Requirements: Node 22+, pnpm, Docker (for Postgres, Redis and k6).

```bash
pnpm install
pnpm start        # starts Postgres+Redis (Docker), pushes the DB schema, then runs everything
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:5173 |
| API | http://localhost:3000 (`/health`) |
| Practice site (deliberately flawed) | http://localhost:4000 |

First test: **Targets → add** `http://localhost:4000` (tick *local / private network*), then run a
load test, a crawl and a security scan against it.

Other commands: `pnpm infra:down`, `pnpm db:studio`, `pnpm typecheck`, `pnpm test`.
Postgres is on port 5434 and Redis on 6380 (see `.env`) so they don't clash with other local services.

## What it does

- **Load tests** – k6 (`ramping-arrival-rate`), per-second p50/p95/p99, throughput, VUs, error rate, live over SSE.
- **Crawler** – in-scope BFS crawl: broken links, redirect chains/loops, missing title/description, slow pages.
- **Security** – passive checks (headers, cookies, TLS, CORS, mixed content, exposed `.env`/`.git`…) plus optional OWASP ZAP baseline/active via Docker.
- **Findings** – tracked across runs by fingerprint; mark Open/Fixed/Ignored.
- **Reports** – history, run-vs-run comparison, JSON/CSV/HTML export (copies are written to `reports/`).

## Safety model (enforced server-side, again in the worker)

- Hosts are allow-listed per target (base host + explicit extra hosts). Redirects are followed manually and every hop is re-checked.
- Private/loopback addresses are blocked unless the target opts in. Cloud-metadata/link-local (169.254.0.0/16) is **always** blocked. k6 also gets `blacklistIPs`.
- Each target has ceilings: req/s, duration, request budget. Over-limit plans are **rejected**, never silently clamped.
- Load tests stop automatically on error-rate / p95 thresholds or when the request budget is exceeded. **Stop now** cancels in ~1s and kills the k6 container.
- One run per type per target at a time; one job at a time in the worker.
- ZAP active scans need the target to be flagged "active scans authorised".
- Every run writes audit events (config, start, stop reason).

## Layout

```
apps/api            Fastify API (+ SSE, exports, compare)
apps/dashboard      React + Vite + Tailwind + Recharts
apps/mock-target    Practice site with built-in flaws
workers             BullMQ worker: load (k6), crawler, security (passive + ZAP)
packages/contracts  Zod schemas and shared types
packages/safety     Scope, private-network, rate/budget and stop rules (unit-tested)
packages/database   Prisma schema + client
infra               docker-compose.yml
```

## Known gaps

- The crawler uses `fetch` + cheerio, so it doesn't execute JavaScript. Playwright (for SPAs) is the next step.
- The ZAP integration is written but has not been exercised yet (the image is large; first run pulls it).
- No authentication in the dashboard/API: it binds to 127.0.0.1 only. Don't expose it.
# siteguard-local
