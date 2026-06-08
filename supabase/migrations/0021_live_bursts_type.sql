-- Run this in the Supabase SQL editor. Idempotent.
--
-- EARLY-SIGNALS PHASE 1 — per-signal-type outcome tracking.
--
-- Adds a `type` discriminator column to live_bursts so the outcome engine can
-- aggregate hit-rates SEPARATELY per signal type:
--   'burst'    — classic ≥N smart-wallet convergence (the existing signal).
--   'early-s1' — a single S-tier smart wallet's first buy (earliest signal).
--   'heating'  — the per-token smart-buy rate is spiking (velocity).
--   'fresh'    — a smart buy on a token younger than FRESH_MAX_AGE_MIN.
--
-- Backs lib/indexer/burst-outcomes.ts (persistBursts/measureBursts/getBurstStats)
-- and lib/indexer/live-bursts.ts (LiveBurst.type).
--
-- GRACEFUL DEGRADATION: the live Early feed (signals 1-6) does NOT depend on this
-- migration. burst-outcomes.ts persists `type` with a try-with-fallback (mirroring
-- the seeded/roi_pct column fallbacks), so until this is applied the persist path
-- simply omits `type` and keeps working — nothing errors.
--
-- Default 'burst' so every existing row (and any insert that omits type) keeps its
-- current meaning; idempotent CREATE-style guard so re-running is a no-op.
alter table live_bursts
  add column if not exists type text not null default 'burst';

-- Index so per-type aggregation (getBurstStats grouped by type) stays cheap.
create index if not exists live_bursts_type_idx on live_bursts (type);
