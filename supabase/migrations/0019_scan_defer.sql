-- SCAN-DEFER: stop the deep-scan budget leak on un-completable wallets.
--
-- A wallet with more swaps than the scan depth (SEED_MAX_TXS) always comes back
-- from Helius truncated → it's left verified=false (we never score on partial
-- history). But the candidate query orders the unverified backlog by
-- total_trades DESC, so those same high-activity wallets sort to the TOP and get
-- re-picked first on every run — re-scanned for ~1k+ Helius credits, truncated
-- again, wasted, indefinitely. That starves the wallets that CAN verify and caps
-- smart-set growth.
--
-- scan_deferred_until parks a truncated wallet for a cooldown so the drain skips
-- it (the budget flows to completable wallets) and retries it later — in case the
-- depth is raised or its history shrinks back under the cap.
alter table wallet_stats add column if not exists scan_deferred_until timestamptz;

-- Partial index for the candidate scan's "not currently deferred" filter:
-- only the rows still in the unverified backlog matter here.
create index if not exists wallet_stats_scan_defer_idx
  on wallet_stats (scan_deferred_until)
  where verified = false;
