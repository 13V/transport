-- Run this in the Supabase SQL editor. Idempotent.
--
-- Disk-IO survival on small compute (Nano: 43 Mbps baseline). Without these,
-- the live feed / indexer / token-page queries do FULL SEQUENTIAL SCANS of the
-- trades table — reading the whole table from disk on every query, which
-- exhausts the Disk IO budget and pins the database. With them, those queries
-- become tiny index lookups.
--
--   trades(wallet, block_time) -- live feed + per-wallet history (the critical one)
--   trades(token_mint, block_time) -- token-page traders / mint burst detection
--   trades(block_time)         -- recent-window scans + the prune-trades cron
--
-- On a large existing table the first build is slow at baseline IO but is a
-- one-time cost; run them one at a time. Pair with the prune-trades cron
-- (TRADES_RETENTION_DAYS, default 14) to keep the table — and IO — bounded.
create index if not exists trades_wallet_time_idx on trades (wallet, block_time);
create index if not exists trades_mint_time_idx   on trades (token_mint, block_time);
create index if not exists trades_time_idx         on trades (block_time);

analyze trades;
