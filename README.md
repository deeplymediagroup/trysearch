# trysearch

An App Store Optimization (ASO) console. You add your iPhone or Android app, it finds the search terms people type into the app stores, scores each one for demand and competition, tracks your position every day, compares you to competitors, and tells you which words to put in your store listing.

**Everything runs on free, public store data. There is no paid data vendor anywhere in this design, and the recurring cost is $0/month.**

---

## Quick start

```bash
npm install
node scripts/init-env.mjs     # writes .env.local (lifts the Neon endpoint from a sibling project)
npm run db:create             # creates the `trysearch` database inside the existing Neon project
npm run db:migrate            # applies db/schema.sql — safe to re-run
npm run smoke                 # GATE 1: proves we can talk to Apple and Google, no credentials needed
npm run dev                   # http://localhost:3080
```

Local password: whatever `CONSOLE_PASSWORD` is set to in `.env.local`.

### Track your first app

Do it in the console: **+ Add app** in the sidebar. Paste a store link, a numeric App Store id,
a bundle id or package name, or just the app's name, and pick it out of the results. Then
**+ Add Keywords** on the Keywords page (one term per line, tick the storefronts) and
**+ Add competitor** on the Competitors page. Untrack from the same screens.

The command line does the same job if you prefer it, and is handy for scripted setup:

```bash
node scripts/seed-app.mjs --ios 1487761500 --countries us,gb --keywords "motivation,discipline,morning routine"
node scripts/seed-app.mjs --ios 1487761500 --competitor 876080126
npm run crawl -- --all
```

Android works the same way with `--android com.example.app`.

Nothing is measured until the crawler runs — a freshly added keyword shows em dashes for
popularity, difficulty and rank until the next crawl fills them in.

---

## The commands

| Command | What it does |
|---|---|
| `npm run dev` | The console, on port 3080 |
| `npm run db:migrate` | Applies `db/schema.sql`. Idempotent — safe to run twice |
| `npm run smoke` | Gate 1: live-tests every store endpoint with no credentials |
| `npm run crawl -- --all` | The full nightly crawl |
| `npm run crawl -- --jobs rank_check,rollup` | Just some jobs |
| `npm run crawl -- --limit 20 --dry` | Plan a run without fetching anything |
| `npm test` | 138 unit tests over the scoring engine, formatters, app resolution and the API scope gate |
| `node scripts/create-api-key.mjs` | Mints a Bearer token for the REST API and the MCP server |
| `node scripts/gate3.mjs` | Verifies the crawler wrote correct, correctly-signed data |
| `node scripts/gate5.mjs` | Verifies the competitive buckets and the alert pipeline |
| `node scripts/gate46.mjs` | Verifies the rendering rules and the listing tools |

---

## How it is put together

```
app/                    Next.js 16 App Router. Every page is a Server Component reading
                        Postgres directly — there is no /api layer for our own UI.
  actions/              Server Actions. What the buttons call.
  api/v1/ + mcp/        The two agent-facing surfaces, both over lib/api-core.ts.
components/             AppShell, DataTable, the cells, the charts, the store mockups,
                        the Add App / Add Keywords dialogs.
lib/
  db.ts / db.mjs        One Postgres interface each for the app and the scripts.
  api-core.ts           ONE operation registry serving both REST and MCP.
  format.ts             EVERY formatter. Nothing else in the codebase formats a number.
  queries.ts            Every read the dashboard performs.
  ai.ts                 The single seam for every language-model call.
  scoring/*.mjs         Pure functions: popularity, difficulty, gap, opportunity,
                        visibility, buckets, the keyword packer, metadata safety.
  stores/*.mjs          The Apple and Google Play clients, the throttled fetch layer,
                        and resolve.mjs — "paste anything" app-reference parsing.
  reviews.ts            Local keyword classifier — review analysis with no API call.
  digest.mjs            The daily alert email.
scripts/                migrate, crawl, smoke, seed-app, and the gate verifiers.
db/schema.sql           37 tables, one view. Raw SQL, no ORM.
docs/spec/              The original specification this was built from.
```

`lib/scoring/` and `lib/stores/` are `.mjs` rather than `.ts` on purpose: the crawler has to
stay a standalone script that runs with plain `node` and no build step, while the Next app
imports the very same functions. One implementation, two consumers.

---

## The rules this codebase holds itself to

These are not style preferences. Each one is load-bearing, and most have a test.

1. **Missing is not zero.** Unmeasured values are `NULL` in the database and an em dash in the UI. A difficulty of `0` means trivially easy; an unmeasured difficulty means we do not know. Conflating them sends users at impossible keywords.
2. **Modelled is labelled.** Parentheses mean our estimate. `5 (28)` is the store's floored 5 alongside our 28.
3. **Country and store on every data point.** A rank without a storefront is meaningless.
4. **Every score is explainable.** The formulas are pure functions and every score cell has an `ⓘ` showing its inputs.
5. **Never fabricate precision.** Two significant figures on modelled numbers; `<$5K/mo` below the revenue floor.
6. **Missing credentials degrade, never throw.** The crawler completes with a populated `warnings` array.

---

## The crawler

One insight makes the whole thing affordable: **one search-results fetch serves every app tracking that keyword.** The crawler loops over unique `(term, platform, country)` triples, fetches once, then extracts the rank of every tracked app in that response and computes difficulty from the same payload. Cost scales with distinct keywords, not with users × keywords.

Eight jobs run in order: `app_snapshot` → `rank_check` → `autocomplete` → `metrics` → `discovery` → `reviews` → `rollup` → `alerts`.

Run it from GitHub Actions (`.github/workflows/crawl.yml`, 02:00 UTC) or from your own machine. **Watch the Actions minutes** — the free tier is ~2,000/month and an unbounded nightly crawl would exceed that. The workflow passes `--limit` for exactly this reason, and running locally is the genuinely unlimited fallback.

---

## The agent-facing surface

Both are live and share one operation registry (`lib/api-core.ts`), so a change lands in both at once:

- **REST** — `/api/v1/...`, Bearer token from `scripts/create-api-key.mjs`.
- **MCP** — `/mcp`, 35 tools: stateless store research, workspace reads, and workspace writes.

**Keys are read-only unless you say otherwise.**

```bash
node scripts/create-api-key.mjs "claude-code"                 # read-only
node scripts/create-api-key.mjs "deploy-bot" --scope write    # may also mutate
```

A read key is refused (`403 forbidden`) on every operation that changes workspace data, and
the MCP server does not even list those tools to it — 24 tools instead of 35. The check lives
in one place, `runOp()`, so it cannot be forgotten when a new surface or operation is added.

Every list endpoint is **cursor-paginated**: responses are `{ items, pagination: { next_cursor,
has_more } }`, and you pass `?cursor=` to continue. Cursors are keyset, not offset — the nightly
crawl mutates these tables while you page, and an offset would silently repeat or skip rows.

---

## What is not built yet

- **App Store Connect and Play Console integrations.** No credentials are read, so `/performance` and `/engagement` render permanently-empty states and the Listing Manager falls back to the public snapshot instead of the hidden Keywords field.
- **The revenue pipeline.** `revenueEstimate()`/`revenueModel()` are implemented and unit-tested, but no crawl job calls them, so `/revenue` is empty.
- **Keyword relevance scoring** — the one AI feature of the four still missing. The other three (competitive landscape, listing generation, AI review analysis) are built and gated behind an explicit button, off unless `ANTHROPIC_API_KEY` is set. `discovered_keywords.relevance` stays NULL until relevance scoring exists.
- **Metrics for discovered keywords.** `rank_check` fetches SERPs for *tracked* keywords only — that queue is the entire crawl budget — so a discovered keyword has no rank, popularity or difficulty of its own. The "Auto-track ranked" switch is wired end to end but stays quiet until discoveries get a rank source.
- **The screenshot studio** — a large, self-contained canvas editor, unrelated to everything else.
- **Android reviews.** Google exposes no free review feed, so `reviews` is iOS-only; the Play Console credential path would be needed.
- **The CLI.** REST + MCP cover the automation needs.

---

## Environment

```
DATABASE_URL                 # Neon Postgres — required
CONSOLE_PASSWORD             # the shared password; unset means the gate is open (local dev)
CREDENTIALS_ENCRYPTION_KEY   # 32 bytes base64, for store_credentials at rest
RESEND_API_KEY               # optional — the daily digest renders without it, just unsent
ANTHROPIC_API_KEY            # optional — the AI features; every one is behind a button, so
                             #            nothing burns tokens on page load
```

`.env*` and `*.p8` are gitignored from the first commit. This app is designed to hold App Store Connect private keys, which can read financial reports, so the password gate is server-side in `proxy.ts` — never a client-side check.
