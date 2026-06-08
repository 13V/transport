-- =========================================================================
-- 0013 — wallet_stats: profit factor + open exposure. Idempotent; re-runnable.
--
-- WHY: the smart-money curation gate (lib/indexer/curation.ts) is being
-- tightened to demand a defensible EDGE, not just a positive ROI. Two new
-- accurate-PnL signals back that gate:
--
--   profit_factor      = gross realized wins / gross realized losses. The
--                        asymmetry signal a win-rate floor deliberately omits:
--                        a great sniper can win <50% of trades yet have a huge
--                        profit factor. >1 = real edge; <1 = bleeding.
--   open_exposure_ratio= remainingCost / (investedSol + remainingCost), i.e.
--                        the share of deployed capital still sitting in OPEN
--                        bags. High = a "holds-losers" wallet whose realized
--                        win rate flatters reality.
--
-- Both are populated by run-seed-indexer.ts from computeAccuratePnL. Wallets
-- scored before this migration have NULL here until they are re-scanned; the
-- gate treats NULL as failing the new floors (see curation.ts), so a backfill
-- re-scan is expected to repopulate the curated set.
-- =========================================================================

alter table if exists wallet_stats
  add column if not exists profit_factor double precision;

alter table if exists wallet_stats
  add column if not exists open_exposure_ratio double precision;
