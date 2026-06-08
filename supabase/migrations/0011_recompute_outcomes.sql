-- Run this in the Supabase SQL editor. Idempotent.
--
-- RECOMPUTE BURST OUTCOMES IN USD (credibility-critical unit fix).
--
-- Every previously-measured burst outcome is unit-corrupted: persistBursts used
-- to stamp price_at_burst from a SOL-per-token spot price, while measureBursts
-- read GeckoTerminal candles in USD. So ret = priceUSD / baselineSOL - 1 mixed
-- two different units and every measured return was ~150x wrong (the SOL/USD
-- scale). That poisoned ret_15m/1h/24h, getBurstStats, the backtester, and the
-- auto-posted "called it" numbers.
--
-- The corrected lib/indexer/burst-outcomes.ts now derives price_at_burst from the
-- SAME USD candle series used for the horizons (the close at/nearest window_end
-- on the deepest-liquidity pool) and reuses it, so baseline and measurements are
-- all USD. To let it recompute cleanly, blank out the old corrupted values on
-- EVERY live_bursts row. The measure cron will re-derive each leg from real USD
-- candles; anything it can't measure stays NULL (no fabrication).
--
-- Idempotent: re-running simply re-NULLs already-NULL columns (a no-op after the
-- measure cron has refilled them, since this only clears, never fabricates).
update live_bursts
set
  price_at_burst  = null,
  price_15m       = null,
  price_1h        = null,
  price_24h       = null,
  peak_price_24h  = null,
  ret_15m         = null,
  ret_1h          = null,
  ret_24h         = null,
  measured_15m_at = null,
  measured_1h_at  = null,
  measured_24h_at = null
where
  price_at_burst  is not null or
  price_15m       is not null or
  price_1h        is not null or
  price_24h       is not null or
  peak_price_24h  is not null or
  ret_15m         is not null or
  ret_1h          is not null or
  ret_24h         is not null or
  measured_15m_at is not null or
  measured_1h_at  is not null or
  measured_24h_at is not null;
