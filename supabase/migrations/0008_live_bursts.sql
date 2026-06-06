-- Run this in the Supabase SQL editor to persist smart-money LIVE BUY BURSTS
-- and the outcomes measured after each burst. Idempotent.
--
-- Backs lib/indexer/burst-outcomes.ts (persistBursts/measureBursts/getBurstStats)
-- and the /api/cron/persist-bursts, /api/cron/measure-bursts cron endpoints, plus
-- the /api/smart-money/live/stats social-proof header.
--
-- One row per burst (keyed by the burst's stable CONTENT HASH `id` from
-- lib/indexer/live-bursts.ts), so re-running the persist cron refreshes a still-
-- growing burst rather than duplicating it. The price_*/ret_*/measured_*_at
-- columns are filled in later by the measure cron from REAL price history; they
-- stay NULL until a horizon has elapsed and a real candle close is available —
-- no number is ever fabricated.
create table if not exists live_bursts (
  id              text             primary key,  -- burst content hash (live-bursts.ts)
  mint            text,
  side            text             default 'buy',
  symbol          text,
  window_start    timestamptz,
  window_end      timestamptz,
  buyers          int,                            -- distinct smart-money ENTITIES
  buyer_wallets   int,                            -- distinct buyer WALLETS
  sol_total       double precision,
  sample_buyers   text[],
  tiers           text[],
  -- Spot price (SOL) stamped ONCE on first insert; the measurement baseline.
  price_at_burst  double precision,
  -- Prices read from real candle history at each horizon (NULL until measured).
  price_15m       double precision,
  price_1h        double precision,
  price_24h       double precision,
  peak_price_24h  double precision,
  -- Percent returns vs price_at_burst (NULL until the leg is measurable).
  ret_15m         double precision,
  ret_1h          double precision,
  ret_24h         double precision,
  measured_15m_at timestamptz,
  measured_1h_at  timestamptz,
  measured_24h_at timestamptz,
  first_seen      timestamptz      default now()
);

create index if not exists live_bursts_window_end_idx on live_bursts (window_end);
create index if not exists live_bursts_mint_idx on live_bursts (mint);
