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
- **Stress tests** – add bots every interval (×2, or +N) until the site strains, find the breaking point, then drop the load and check recovery. See below.
- **Findings** – tracked across runs by fingerprint; mark Open/Fixed/Ignored.
- **Reports** – history, run-vs-run comparison, JSON/CSV/HTML export (copies are written to `reports/`).

## Stress tests and journeys

A **journey** is what one bot does: ordered HTTP steps (login, search, add to cart, checkout) that share cookies and extracted values. Build them on the **Journeys** page (method, path, body, *extract* values for later steps, *checks*, think time, and optional *verify* steps that run after the load to catch data-integrity problems such as duplicate orders). **Test once** runs a journey with a single bot before you commit to a stress test.

Templates inside paths, headers and bodies: `{{name}}` (extracted earlier), `{{data.field}}` (a column of the dataset: each bot uses a different row), `{{env.SG_NAME}}` (a secret read from your `.env`; only `SG_*` names are allowed and values are never stored in the database, audit log or exports).

Datasets live in `datasets/` (JSON array or CSV with a header row; the folder is git-ignored except `users.example.json`).

On the **Stress** page choose a profile:

| Profile | What it does |
|---|---|
| `step` | hold at each bot level (start → ×2 → ×4 …) so you see which load causes trouble |
| `ramp` | keep adding bots continuously until it breaks |
| `spike` | sudden burst, then back to baseline |
| `soak` | hold a high level for a long time; reveals leaks and drift |
| `quick` | ApacheBench-style: N requests at concurrency C (`ab -n 1000 -c 100`) |

Growth per interval is *multiply by a factor* or *add a fixed number*, capped at max bots; the page previews the schedule. A traffic **mix** with weights (browse 70 / checkout 10) picks journeys per bot. Engine `hybrid` adds a few real Chromium bots that report Core Web Vitals (TTFB, FCP, LCP, CLS) while the protocol bots push the backend.

You must write a **hypothesis** before you start. Results: health verdicts (response time steady, errors under 1%, throughput levelling smoothly), the **breaking point**, failure pattern (hockey stick, errors before slowness, partial failure), a status-code table that explains 502/503/504/429 and network failures, per-step stats, cache hit ratio, WAF/rate-limit blocks, recovery time, data-integrity checks, soak drift, and findings with fixes. Comparing two runs warns when more than one setting changed.

What this can and cannot see: from outside we see latency, errors and throughput, not memory, query plans or pool sizes. Causes are reported as *indicators to check*. If the target runs in a local Docker container, set its container name on the target and CPU/memory are sampled with `docker stats`, which gives real numbers.

Out of scope on purpose: network-layer (L3/L4) floods or any "IP stresser" behaviour; this only sends HTTP requests, at ceilings you set, to targets you have marked as yours. Your machine's CPU and bandwidth also limit how much traffic it can generate. Payment steps should point at a sandbox or mock: third-party processors have their own, lower rate limits.

## Safety model (enforced server-side, again in the worker)

- Hosts are allow-listed per target (base host + explicit extra hosts). Redirects are followed manually and every hop is re-checked.
- Private/loopback addresses are blocked unless the target opts in. Cloud-metadata/link-local (169.254.0.0/16) is **always** blocked. k6 also gets `blacklistIPs`.
- Each target has ceilings: req/s, duration, request budget. Over-limit plans are **rejected**, never silently clamped.
- Load tests stop automatically on error-rate / p95 thresholds or when the request budget is exceeded. **Stop now** cancels in ~1s and kills the k6 container.
- Runs of any type, against the same or different targets, execute concurrently (`WORKER_CONCURRENCY` in `.env`, default 4 — bounded by your machine's CPU/RAM, since each run can spawn its own k6/Docker process or Chromium instance). Each run's own ceilings still apply to it individually, but **concurrent runs on the same target are not rate-limited in aggregate** — e.g. two LOAD/STRESS runs on one target will add their traffic together. OWASP ZAP is the one exception: its Docker container binds a fixed proxy port, so a second ZAP scan always waits for the first to finish, regardless of what else is running.
- Stress tests need the target to be marked **stress tests authorised** (a separate opt-in) and have their own ceilings (bots, req/s, duration, request budget). Bots pause between requests so the req/s ceiling holds by construction, the whole bot schedule is checked up front, and the run also aborts if the observed rate or request count goes over.
- Journey paths are resolved and scope-checked before the test starts; protocol-relative paths and undeclared variables are rejected. Dataset names cannot escape `datasets/`.
- ZAP active scans need the target to be flagged "active scans authorised".
- Every run writes audit events (config, start, stop reason).

## Layout

```
apps/api            Fastify API (+ SSE, exports, compare)
apps/dashboard      React + Vite + Tailwind + Recharts
apps/mock-target    Practice site with built-in flaws
workers             BullMQ worker: load and stress (k6), browser bots (Playwright), crawler, security (passive + ZAP)
packages/contracts  Zod schemas and shared types
packages/safety     Scope, private-network, rate/budget and stop rules (unit-tested)
packages/database   Prisma schema + client
infra               docker-compose.yml
```

## Known gaps

- The stress k6 script runs in k6 and carries its own copy of the template logic; the browser bots and the dry run share a TypeScript copy.
- The crawler uses `fetch` + cheerio by default. Tick **Render JavaScript** (or set `renderJs: true`) to render each page in headless Chromium via Playwright so SPA links and metadata are found. One-time setup: `pnpm --filter @siteguard/workers exec playwright install chromium`. Browser requests are scope-checked the same way as everything else; set `CHROMIUM_PATH` to use an existing Chromium.
- The ZAP integration is written but has not been exercised yet (the image is large; first run pulls it).
- No authentication in the dashboard/API: it binds to 127.0.0.1 only. Don't expose it.
