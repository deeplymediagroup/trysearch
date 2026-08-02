-- ============================================================================
-- trysearch.app — PostgreSQL schema (Neon)
--
-- Conventions (matching Brandon's other apps):
--   * raw SQL, no ORM
--   * idempotent: safe to re-run
--   * applied by scripts/migrate.mjs  (npm run db:migrate)
--   * all writes come from the Next.js server using DATABASE_URL; the browser
--     never sees the connection string, so no row-level security is needed --
--     the connection string IS the access control.
--
-- HARD RULES ENCODED HERE (do not "clean these up"):
--   1. Unmeasured numbers are NULL, never 0. A difficulty of 0 means trivially
--      easy; NULL means we don't know. The UI renders NULL as an em dash.
--   2. Every keyword and every rank is scoped to (platform, country). A rank
--      without a storefront is meaningless.
--   3. Modelled values carry their provenance next to them (*_source columns)
--      so the UI can label an estimate as an estimate.
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_trgm";    -- fuzzy keyword search

-- ---------------------------------------------------------------------------
-- Enumerated domains. Text + CHECK rather than native enums, so adding a value
-- is a one-line migration instead of an ALTER TYPE dance.
-- ---------------------------------------------------------------------------

-- platform: 'ios' | 'android'
-- country:  ISO 3166-1 alpha-2, lowercase, e.g. 'us'
-- device:   'iphone' | 'ipad' | 'android_phone' | 'android_tablet'


-- ===========================================================================
-- ACCOUNTS
-- ===========================================================================
-- If you use a hosted auth provider, `users` mirrors it: external_id is the
-- provider's user id and is the only link. If you use the single-password
-- pattern from Brandon's other apps, seed exactly one row here.

create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  external_id       text unique,                      -- auth provider subject, null for single-tenant
  email             text not null,
  name              text,
  plan              text not null default 'free'
                    check (plan in ('free','trial','indie','agency','self')),
  trial_ends_at     timestamptz,
  alert_email       text,                             -- override; falls back to email
  alerts_paused     boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists workspaces (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references users(id) on delete cascade,
  name              text not null default 'My workspace',
  created_at        timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  user_id           uuid not null references users(id) on delete cascade,
  role              text not null default 'member' check (role in ('owner','member','viewer')),
  created_at        timestamptz not null default now(),
  primary key (workspace_id, user_id)
);


-- ===========================================================================
-- APPS
-- ===========================================================================
-- `apps` is a global catalogue of every app we know about -- the user's own
-- apps AND every competitor AND every app we saw in a SERP. One row per
-- (platform, store_id). Deduplicating here is what makes competitor discovery
-- and SERP difficulty cheap.

create table if not exists apps (
  id                uuid primary key default gen_random_uuid(),
  platform          text not null check (platform in ('ios','android')),
  store_id          text not null,          -- iOS: numeric trackId. Android: package name.
  bundle_id         text,
  name              text not null,
  developer_name    text,
  developer_id      text,
  icon_url          text,
  primary_genre     text,
  genres            text[],
  price_cents       integer,
  currency          text,
  content_rating    text,
  version           text,
  released_at       timestamptz,
  version_released_at timestamptz,
  primary_country   text,                   -- auto-detected primary storefront
  is_free           boolean,
  has_iap           boolean,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (platform, store_id)
);

create index if not exists apps_name_trgm on apps using gin (name gin_trgm_ops);

-- Apps a workspace actively tracks (its own apps + its competitors).
create table if not exists tracked_apps (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  app_id            uuid not null references apps(id) on delete cascade,
  role              text not null check (role in ('own','competitor')),
  -- for role='competitor', which of the workspace's own apps it competes with
  competitor_of     uuid references tracked_apps(id) on delete cascade,
  device            text default 'iphone',
  is_active         boolean not null default true,
  -- when true, the rollup job promotes discovered keywords that are actually RANKING
  -- into tracked_keywords (capped per run). Ideas that don't rank are never auto-tracked.
  auto_track_ranked boolean not null default false,
  added_at          timestamptz not null default now(),
  unique (workspace_id, app_id, competitor_of)
);

-- The table predates auto_track_ranked, so add it for installs migrated before it existed.
alter table tracked_apps add column if not exists auto_track_ranked boolean not null default false;

create index if not exists tracked_apps_ws on tracked_apps(workspace_id) where is_active;

-- Daily metadata snapshot. This table is the sole input to the Activity feed:
-- an activity event is a diff between consecutive snapshots.
create table if not exists app_snapshots (
  id                bigserial primary key,
  app_id            uuid not null references apps(id) on delete cascade,
  country           text not null,
  locale            text,
  captured_on       date not null,
  name              text,
  subtitle          text,
  keywords_field    text,                   -- only ever available for our OWN apps via ASC
  description       text,
  promotional_text  text,
  release_notes     text,
  version           text,
  price_cents       integer,
  currency          text,
  primary_genre     text,
  icon_url          text,
  screenshot_urls   text[],
  rating_average    numeric(3,2),
  rating_count      integer,
  install_count     bigint,                 -- Android only; Play publishes it, Apple does not
  raw               jsonb,                  -- full upstream payload, for reprocessing without re-fetching
  captured_at       timestamptz not null default now(),
  unique (app_id, country, captured_on)
);

create index if not exists app_snapshots_app_date on app_snapshots(app_id, captured_on desc);


-- ===========================================================================
-- KEYWORDS
-- ===========================================================================
-- A keyword is a (term, platform, country) triple. Metrics live here and are
-- shared across every workspace that tracks the same term -- that sharing is
-- what keeps us inside Apple's rate limits.

create table if not exists keywords (
  id                bigserial primary key,
  term              text not null,
  term_normalized   text not null,          -- lowercased, whitespace-collapsed, NFKC
  platform          text not null check (platform in ('ios','android')),
  country           text not null,
  language          text,
  word_count        integer not null default 1,

  -- ---- demand -----------------------------------------------------------
  popularity        integer check (popularity between 0 and 100),
  popularity_source text check (popularity_source in ('store','proxy')),
  -- when the store floors/censors the real value we keep both: `popularity`
  -- holds what the store said (often 5) and `popularity_estimate` holds ours.
  popularity_estimate integer check (popularity_estimate between 0 and 100),

  -- ---- competition ------------------------------------------------------
  difficulty        integer check (difficulty between 0 and 100),   -- NULL = unmeasured, never 0
  difficulty_parts  jsonb,                  -- {leaders, titleMatch, depth, specificity} for the ⓘ popover
  serp_depth        integer,                -- how many results the store returned
  serp_outlier      boolean not null default false,
  est_downloads_rank1 integer,              -- "Est. #1 downloads" column

  metrics_updated_at timestamptz,
  created_at        timestamptz not null default now(),
  unique (term_normalized, platform, country)
);

create index if not exists keywords_term_trgm on keywords using gin (term gin_trgm_ops);
create index if not exists keywords_stale on keywords(metrics_updated_at nulls first);

-- Autocomplete observations. The raw signal behind the popularity proxy:
-- for prefix P in storefront S, term T appeared at position N.
create table if not exists autocomplete_hits (
  id                bigserial primary key,
  platform          text not null check (platform in ('ios','android')),
  country           text not null,
  prefix            text not null,
  term              text not null,
  term_normalized   text not null,
  position          integer not null,       -- 0-indexed slot in the suggestion list
  observed_on       date not null,
  observed_at       timestamptz not null default now(),
  unique (platform, country, prefix, term_normalized, observed_on)
);

create index if not exists autocomplete_term on autocomplete_hits(term_normalized, platform, country);

-- Keywords a workspace has chosen to track for a specific app.
create table if not exists tracked_keywords (
  id                bigserial primary key,
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  tracked_app_id    uuid not null references tracked_apps(id) on delete cascade,
  keyword_id        bigint not null references keywords(id) on delete cascade,
  source            text not null default 'manual'
                    check (source in ('manual','suggested','competitor','autocomplete','listing','ai')),
  is_branded        boolean not null default false,
  starred           boolean not null default false,
  note              text,
  tags              text[],
  added_at          timestamptz not null default now(),
  unique (tracked_app_id, keyword_id)
);

create index if not exists tracked_keywords_app on tracked_keywords(tracked_app_id);
create index if not exists tracked_keywords_ws on tracked_keywords(workspace_id);

-- Keywords we found but the user has not promoted to tracked yet.
create table if not exists discovered_keywords (
  id                bigserial primary key,
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  tracked_app_id    uuid not null references tracked_apps(id) on delete cascade,
  keyword_id        bigint not null references keywords(id) on delete cascade,
  source            text not null check (source in ('autocomplete','listing','competitor','ai','chart')),
  relevance         integer check (relevance between 0 and 100),   -- AI-assessed intent match; NULL until computed
  opportunity       integer check (opportunity between 0 and 100),
  last_checked_at   timestamptz,            -- NULL renders as "never"
  dismissed         boolean not null default false,
  discovered_at     timestamptz not null default now(),
  unique (tracked_app_id, keyword_id)
);

create index if not exists discovered_open on discovered_keywords(tracked_app_id)
  where dismissed = false;

-- Per-app, per-locale target keywords (max 3; slot 1 -> App Name, 2-3 -> Subtitle)
create table if not exists target_keywords (
  id                bigserial primary key,
  tracked_app_id    uuid not null references tracked_apps(id) on delete cascade,
  locale            text not null,
  slot              smallint not null check (slot between 1 and 3),
  keyword_id        bigint not null references keywords(id) on delete cascade,
  set_at            timestamptz not null default now(),
  unique (tracked_app_id, locale, slot)
);


-- ===========================================================================
-- RANKINGS
-- ===========================================================================
-- The biggest table. One row per app per keyword per day.
--
-- `rank` semantics -- the four-valued state from the product spec:
--     rank = 1..N   -> currently ranked at that position
--     rank IS NULL and found_at_depth = false -> checked, not in the top N
--     no row at all -> not checked that day
-- `last_known_rank` lets the UI render ">200 (was #163)".

create table if not exists rankings (
  id                bigserial primary key,
  app_id            uuid not null references apps(id) on delete cascade,
  keyword_id        bigint not null references keywords(id) on delete cascade,
  checked_on        date not null,
  rank              integer check (rank > 0),
  crawl_depth       integer not null,       -- how deep we looked (e.g. 200)
  found             boolean not null,       -- false = checked and absent
  last_known_rank   integer,                -- carried forward when found = false
  checked_at        timestamptz not null default now(),
  unique (app_id, keyword_id, checked_on)
);

create index if not exists rankings_lookup on rankings(app_id, keyword_id, checked_on desc);
create index if not exists rankings_by_day  on rankings(checked_on);
-- When this table gets large, partition by RANGE (checked_on) monthly.

-- Denormalised "current state" row, one per (app, keyword). Maintained by the
-- crawler on write. Exists so /keywords and /rankings render from one indexed
-- read instead of a window function over the whole history.
create table if not exists ranking_current (
  app_id            uuid not null references apps(id) on delete cascade,
  keyword_id        bigint not null references keywords(id) on delete cascade,
  rank              integer,
  found             boolean not null default false,
  last_known_rank   integer,
  delta_1d          integer,
  delta_7d          integer,
  delta_30d         integer,
  avg_7d            numeric(6,2),
  avg_30d           numeric(6,2),
  best_rank         integer,
  best_rank_on      date,
  first_ranked_on   date,
  checked_at        timestamptz,
  primary key (app_id, keyword_id)
);

-- The SERP itself: which apps occupied which positions for a keyword.
-- Powers the "Top Results" icon strip, the SERP drawer, difficulty scoring,
-- and competitor/gap analysis. Keep only the most recent N per keyword plus
-- weekly archives -- storing every day forever is not worth the disk.
create table if not exists serp_results (
  id                bigserial primary key,
  keyword_id        bigint not null references keywords(id) on delete cascade,
  captured_on       date not null,
  position          integer not null,
  app_id            uuid not null references apps(id) on delete cascade,
  rating_count      integer,
  rating_average    numeric(3,2),
  title_match       boolean,                -- app name contains every query word
  unique (keyword_id, captured_on, position)
);

create index if not exists serp_by_keyword on serp_results(keyword_id, captured_on desc);


-- ===========================================================================
-- COMPETITIVE POSITION
-- ===========================================================================
-- Materialised per rank-check so /competitors renders instantly.
-- bucket is derived, not user-set:
--   'gap'      competitor ranks, we do not (or far worse)
--   'winnable' a gap whose difficulty is low enough to take
--   'threat'   competitor currently outranks us
--   'lead'     we outrank every tracked competitor

create table if not exists competitive_positions (
  id                bigserial primary key,
  tracked_app_id    uuid not null references tracked_apps(id) on delete cascade,
  keyword_id        bigint not null references keywords(id) on delete cascade,
  best_competitor_app_id uuid references apps(id) on delete set null,
  their_rank        integer,
  our_rank          integer,
  opportunity       integer check (opportunity between 0 and 100),
  bucket            text not null check (bucket in ('gap','winnable','threat','lead')),
  computed_at       timestamptz not null default now(),
  unique (tracked_app_id, keyword_id)
);

create index if not exists comppos_bucket on competitive_positions(tracked_app_id, bucket, opportunity desc);

-- AI competitive landscape reports. Rate limit: one per app per 7 days.
create table if not exists ai_analyses (
  id                uuid primary key default gen_random_uuid(),
  tracked_app_id    uuid not null references tracked_apps(id) on delete cascade,
  kind              text not null default 'competitive_landscape',
  posture           text,
  opportunities     jsonb,                  -- [{title, detail}]
  threats           jsonb,
  strengths         jsonb,
  model             text,
  created_at        timestamptz not null default now()
);

create index if not exists ai_analyses_recent on ai_analyses(tracked_app_id, created_at desc);


-- ===========================================================================
-- DAILY ROLLUPS  (dashboard + portfolio read from here, never from raw rankings)
-- ===========================================================================

create table if not exists app_daily_metrics (
  app_id            uuid not null references apps(id) on delete cascade,
  metric_on         date not null,
  visibility        numeric(6,2),           -- popularity-weighted rank reach, 0-100
  share_of_voice    numeric(6,3),           -- % of tracked non-branded demand captured
  ranked_count      integer not null default 0,
  top3_count        integer not null default 0,
  top10_count       integer not null default 0,
  bracket_11_30     integer not null default 0,
  bracket_31_100    integer not null default 0,
  bracket_100_plus  integer not null default 0,
  best_rank         integer,
  best_rank_keyword_id bigint references keywords(id) on delete set null,
  movers_up         integer not null default 0,
  movers_down       integer not null default 0,
  primary key (app_id, metric_on)
);


-- ===========================================================================
-- REVIEWS
-- ===========================================================================

create table if not exists reviews (
  id                bigserial primary key,
  app_id            uuid not null references apps(id) on delete cascade,
  country           text not null,
  store_review_id   text not null,
  rating            smallint not null check (rating between 1 and 5),
  title             text,
  body              text,
  author            text,
  app_version       text,
  helpful_count     integer,
  reviewed_at       timestamptz,
  fetched_at        timestamptz not null default now(),
  unique (app_id, country, store_review_id)
);

create index if not exists reviews_recent on reviews(app_id, reviewed_at desc);
create index if not exists reviews_rating on reviews(app_id, rating);

-- Output of "Analyze reviews".
create table if not exists review_analyses (
  id                uuid primary key default gen_random_uuid(),
  app_id            uuid not null references apps(id) on delete cascade,
  window_start      date,
  window_end        date,
  review_count      integer,
  praise            jsonb,                  -- [{theme, count, quotes[]}]
  complaints        jsonb,
  feature_requests  jsonb,
  model             text,
  created_at        timestamptz not null default now()
);

-- Daily review-volume counters, so "review spike" alerts have a baseline.
create table if not exists review_daily_counts (
  app_id            uuid not null references apps(id) on delete cascade,
  counted_on        date not null,
  new_reviews       integer not null default 0,
  rating_average    numeric(3,2),
  primary key (app_id, counted_on)
);


-- ===========================================================================
-- ACTIVITY  (diff of consecutive app_snapshots)
-- ===========================================================================

create table if not exists activity_events (
  id                bigserial primary key,
  app_id            uuid not null references apps(id) on delete cascade,
  country           text,
  kind              text not null check (kind in
                      ('release','metadata','screenshots','price','category','icon','rating')),
  field             text,                   -- e.g. 'subtitle'
  old_value         text,
  new_value         text,
  release_notes     text,
  occurred_on       date not null,
  created_at        timestamptz not null default now()
);

create index if not exists activity_recent on activity_events(app_id, occurred_on desc);

-- Chart annotations on /rankings. Release events auto-create one.
create table if not exists annotations (
  id                bigserial primary key,
  tracked_app_id    uuid not null references tracked_apps(id) on delete cascade,
  occurred_on       date not null,
  label             text not null,          -- e.g. 'Shipped v2.0'
  auto              boolean not null default false,
  created_at        timestamptz not null default now()
);


-- ===========================================================================
-- ALERTS
-- ===========================================================================

create table if not exists alert_settings (
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  kind              text not null check (kind in
                      ('rank_drop','out_of_top10','new_ranking','rank_gain',
                       'entered_top10','rating_drop','review_spike','competitor_change')),
  enabled           boolean not null default false,   -- everything off until turned on
  threshold         integer,                          -- rank_drop: minimum drop, default 20
  primary key (workspace_id, kind)
);

create table if not exists alerts (
  id                bigserial primary key,
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  app_id            uuid not null references apps(id) on delete cascade,
  keyword_id        bigint references keywords(id) on delete set null,
  kind              text not null,
  message           text not null,          -- rendered sentence, incl. store + country
  platform          text,
  country           text,
  from_rank         integer,
  to_rank           integer,
  occurred_on       date not null,
  emailed_at        timestamptz,
  read_at           timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists alerts_feed on alerts(workspace_id, occurred_on desc);
create index if not exists alerts_unsent on alerts(workspace_id) where emailed_at is null;


-- ===========================================================================
-- LISTINGS  (Listing Manager / Listing Helper)
-- ===========================================================================

create table if not exists listings (
  id                uuid primary key default gen_random_uuid(),
  tracked_app_id    uuid not null references tracked_apps(id) on delete cascade,
  locale            text not null,
  country           text,
  status            text not null default 'live' check (status in ('live','draft')),
  is_primary        boolean not null default false,
  app_name          text,
  subtitle          text,
  keywords_field    text,
  promotional_text  text,
  description       text,
  release_notes     text,
  source            text not null default 'store' check (source in ('store','asc','user','generated')),
  synced_at         timestamptz,
  updated_at        timestamptz not null default now(),
  unique (tracked_app_id, locale, status)
);

-- Generated listing candidates from Listing Helper, kept so users can compare.
create table if not exists listing_drafts (
  id                uuid primary key default gen_random_uuid(),
  tracked_app_id    uuid not null references tracked_apps(id) on delete cascade,
  locale            text not null,
  app_name          text,
  subtitle          text,
  keywords_field    text,
  promotional_text  text,
  description       text,
  -- why each character of the keyword field is there (from packKeywordField)
  rationale         jsonb,
  model             text,
  created_at        timestamptz not null default now()
);


-- ===========================================================================
-- SCREENSHOT STUDIO
-- ===========================================================================

create table if not exists screenshot_sets (
  id                uuid primary key default gen_random_uuid(),
  tracked_app_id    uuid not null references tracked_apps(id) on delete cascade,
  name              text not null,
  platform          text not null check (platform in ('ios','android')),
  device_label      text not null,          -- 'iPhone 6.7"'
  width_px          integer not null,
  height_px         integer not null,
  template          text,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

create table if not exists screenshot_slides (
  id                uuid primary key default gen_random_uuid(),
  set_id            uuid not null references screenshot_sets(id) on delete cascade,
  locale            text not null,
  position          integer not null,
  headline          text,
  subhead           text,
  image_url         text,
  config            jsonb,                  -- frame, colours, offsets
  unique (set_id, locale, position)
);


-- ===========================================================================
-- FIRST-PARTY ANALYTICS  (App Store Connect / Play Console)
-- ===========================================================================

create table if not exists store_credentials (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  provider          text not null check (provider in ('asc','play')),
  -- Store only ciphertext. Encrypt with a key from the environment, never a
  -- column default, and never log these values.
  payload_encrypted bytea not null,
  key_id            text,
  issuer_id         text,
  status            text not null default 'active' check (status in ('active','error','revoked')),
  last_error        text,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now(),
  unique (workspace_id, provider)
);

create table if not exists asc_daily_metrics (
  app_id            uuid not null references apps(id) on delete cascade,
  metric_on          date not null,
  country            text not null default 'ALL',
  downloads_first_time integer,
  downloads_redownload integer,
  iap_units          integer,
  proceeds_usd       numeric(12,2),         -- approximate; static FX. Label it in the UI.
  impressions        integer,
  product_page_views integer,
  impressions_search integer,
  impressions_browse integer,
  impressions_app_referrer integer,
  impressions_web_referrer integer,
  primary key (app_id, metric_on, country)
);


-- ===========================================================================
-- REVENUE ESTIMATES
-- ===========================================================================

create table if not exists revenue_estimates (
  id                bigserial primary key,
  app_id            uuid not null references apps(id) on delete cascade,
  estimated_on      date not null,
  model             text not null check (model in ('subscription','paid','freemium','ad_supported','unknown')),
  confidence        text not null check (confidence in ('high','medium','low')),
  monthly_usd_low   integer,
  monthly_usd_high  integer,
  display           text not null,          -- '$271K/mo' or '<$5K/mo'
  factors           jsonb,                  -- the inputs, for the disclosure panel
  computed_at       timestamptz not null default now(),
  unique (app_id, estimated_on)
);

-- Real IAP prices scraped from the store product page. This is what turns a
-- revenue guess into a priced model.
create table if not exists app_iaps (
  id                bigserial primary key,
  app_id            uuid not null references apps(id) on delete cascade,
  name              text not null,
  price_cents       integer,
  currency          text,
  is_subscription   boolean,
  period            text,                   -- 'week' | 'month' | 'year'
  annualised_cents  integer,
  captured_on       date not null,
  unique (app_id, name, captured_on)
);


-- ===========================================================================
-- JOB PLUMBING
-- ===========================================================================
-- The crawler is the part most likely to break. Make its behaviour queryable.

create table if not exists crawl_jobs (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in
                      ('rank_check','autocomplete','app_snapshot','reviews','metrics',
                       'discovery','rollup','alerts','asc_sync','play_sync')),
  status            text not null default 'queued'
                    check (status in ('queued','running','done','failed','partial')),
  scope             jsonb,                  -- {app_id, country, ...}
  attempts          integer not null default 0,
  items_total       integer,
  items_done        integer,
  warnings          jsonb not null default '[]'::jsonb,
  error             text,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists crawl_jobs_open on crawl_jobs(kind, status, created_at);

-- Fetch ledger. One row per upstream HTTP call. This is how you diagnose
-- throttling instead of guessing, and how the global politeness budget is
-- enforced across all users.
create table if not exists fetch_log (
  id                bigserial primary key,
  host              text not null,
  endpoint          text not null,
  country           text,
  status_code       integer,
  duration_ms       integer,
  throttled         boolean not null default false,
  fetched_at        timestamptz not null default now()
);

create index if not exists fetch_log_recent on fetch_log(host, fetched_at desc);

-- Shared response cache, so N users asking for the same keyword cost one call.
create table if not exists upstream_cache (
  cache_key         text primary key,
  payload           jsonb not null,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now()
);

create index if not exists upstream_cache_expiry on upstream_cache(expires_at);


-- ===========================================================================
-- API ACCESS (only if you expose a public API; skip for personal use)
-- ===========================================================================

create table if not exists api_keys (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  name              text,
  token_hash        text not null unique,   -- store a hash, never the token
  prefix            text not null,          -- first 8 chars, for display
  -- Read is the default on purpose: an agent must not be able to untrack 2,000 keywords
  -- on a misread. Ops that mutate are marked `write: true` in lib/api-core.ts and are
  -- refused (403 forbidden) for a read key.
  scope             text not null default 'read' check (scope in ('read','write')),
  requests_per_day  integer not null default 1000,
  last_used_at      timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now()
);

-- api_keys predates `scope`; existing keys migrate to read-only, which is the safe default.
alter table api_keys add column if not exists scope text not null default 'read';
do $$ begin
  alter table api_keys add constraint api_keys_scope_check check (scope in ('read','write'));
exception when duplicate_object then null; end $$;

create table if not exists api_usage (
  api_key_id        uuid not null references api_keys(id) on delete cascade,
  used_on           date not null,
  requests          integer not null default 0,
  primary key (api_key_id, used_on)
);


-- ===========================================================================
-- HELPFUL VIEWS
-- ===========================================================================

-- Everything /keywords needs for one app, in one read.
create or replace view v_tracked_keyword_rows as
select
  tk.id                as tracked_keyword_id,
  tk.tracked_app_id,
  tk.workspace_id,
  tk.source,
  tk.starred,
  tk.note,
  tk.is_branded,
  k.id                 as keyword_id,
  k.term,
  k.platform,
  k.country,
  k.popularity,
  k.popularity_source,
  k.popularity_estimate,
  k.difficulty,
  k.difficulty_parts,
  k.serp_outlier,
  k.est_downloads_rank1,
  k.metrics_updated_at,
  -- Gap: only defined when both sides are measured.
  case
    when k.difficulty is null then null
    else coalesce(k.popularity_estimate, k.popularity) - k.difficulty
  end                  as gap,
  rc.rank,
  rc.found,
  rc.last_known_rank,
  rc.delta_1d,
  rc.delta_7d,
  rc.delta_30d,
  rc.avg_7d,
  rc.avg_30d,
  rc.best_rank,
  rc.checked_at
from tracked_keywords tk
join keywords k        on k.id = tk.keyword_id
join tracked_apps ta   on ta.id = tk.tracked_app_id
left join ranking_current rc
       on rc.keyword_id = tk.keyword_id
      and rc.app_id     = ta.app_id;
