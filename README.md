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

```bash
node scripts/seed-app.mjs --ios 1487761500 --countries us,gb --keywords "motivation,discipline,morning routine"
node scripts/seed-app.mjs --ios 1487761500 --competitor 876080126
npm run crawl -- --all
```

Android works the same way with `--android com.example.app`.

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
| `npm test` | 124 unit tests over the scoring engine and formatters |
| `node scripts/gate3.mjs` | Verifies the crawler wrote correct, correctly-signed data |
| `node scripts/gate5.mjs` | Verifies the competitive buckets and the alert pipeline |
| `node scripts/gate46.mjs` | Verifies the rendering rules and the listing tools |

---

## How it is put together

```
app/                    Next.js 16 App Router. Every page is a Server Component reading
                        Postgres directly — there is no /api layer for our own UI.
  actions/              Server Actions. What the buttons call.
components/             AppShell, DataTable, the cells, the charts, the store mockups.
lib/
  db.ts / db.mjs        One Postgres interface each for the app and the scripts.
  format.ts             EVERY formatter. Nothing else in the codebase formats a number.
  queries.ts            Every read the dashboard performs.
  scoring/*.mjs         Pure functions: popularity, difficulty, gap, opportunity,
                        visibility, buckets, the keyword packer, metadata safety.
  stores/*.mjs          The Apple and Google Play clients, plus the throttled fetch layer.
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

## What is deliberately not built

Phase 7 of the spec is optional forever, and none of it ships here:

- **The four AI features** (keyword relevance, competitive analyses, listing generation, AI review analysis). Everything else costs $0/month and the build plan says to keep it that way. Review analysis uses a local keyword classifier instead, and it works today.
- **App Store Connect and Play Console integrations** — the clients exist in Brandon's other repos and need credentials. `/performance` and `/engagement` are not built.
- **The screenshot studio** — a large, self-contained canvas editor, unrelated to everything else.
- **The public REST API, the CLI, and the MCP server.** The MCP server is the highest-value of these and is the obvious next thing to build.

---

## Environment

```
DATABASE_URL                 # Neon Postgres — required
CONSOLE_PASSWORD             # the shared password; unset means the gate is open (local dev)
CREDENTIALS_ENCRYPTION_KEY   # 32 bytes base64, for store_credentials at rest
RESEND_API_KEY               # optional — the daily digest renders without it, just unsent
ANTHROPIC_API_KEY            # optional — the four AI features, all currently unbuilt
```

`.env*` and `*.p8` are gitignored from the first commit. This app is designed to hold App Store Connect private keys, which can read financial reports, so the password gate is server-side in `proxy.ts` — never a client-side check.
