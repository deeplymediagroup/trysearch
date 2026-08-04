-- ============================================================================
-- Trends (market-wide keyword niche watch) — applied by scripts/trends-job.mjs
-- on every run (idempotent, same convention as db/schema.sql). scripts/migrate.mjs
-- only applies schema.sql, so this file carries its own DDL.
--
-- Row design: one run = one shared computed_at timestamp.
--   * one row per AI-named niche: name, why_now, momentum (0-100, computed in
--     code from first-seen dates, never by the AI), member_terms = jsonb array
--     of strings, rising = NULL.
--   * plus exactly one meta row per run: name = '__rising__', momentum NULL,
--     member_terms NULL, rising = jsonb array of {term, relevance, first_seen}.
-- The page reads the latest computed_at and splits on name = '__rising__'.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists trend_niches (
  id            uuid primary key default gen_random_uuid(),
  computed_at   timestamptz not null default now(),
  name          text not null,
  why_now       text,
  momentum      int check (momentum between 0 and 100),
  member_terms  jsonb,
  rising        jsonb
);

create index if not exists trend_niches_recent on trend_niches (computed_at desc);
