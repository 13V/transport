-- Run this in the Supabase SQL editor. Idempotent.
--
-- PARTIAL INDEXES aligned to the HOT live-feed access pattern. The live feed and
-- the smart-money exit annotation both query trades by trade_type + wallet +
-- block_time, e.g.:
--
--   trade_type = 'BUY'  AND wallet IN (...) AND block_time >= since   (live feed buys)
--   trade_type = 'SELL' AND wallet IN (...) AND block_time >= since   (exit signal)
--
-- The existing trades_wallet_time_idx (wallet, block_time) serves the wallet +
-- block_time part, but trade_type is left as a HEAP FILTER — every candidate row
-- is read from disk just to discard the wrong side. On a Disk-IO-constrained
-- compute that heap fetch is the waste.
--
-- These PARTIAL indexes encode trade_type IN the index predicate, so the wrong
-- side is never visited and the index itself is smaller (only BUY rows / only
-- SELL rows). The planner uses them whenever the query has a matching constant
-- trade_type filter, turning the hot feed query into a tight index-only-ish scan.
--
-- Safe alongside 0010's trades_wallet_time_idx (that stays for queries without a
-- trade_type constant). Build one at a time on a large table.
create index if not exists trades_buy_wallet_time_idx
  on trades (wallet, block_time desc)
  where trade_type = 'BUY';

create index if not exists trades_sell_wallet_time_idx
  on trades (wallet, block_time desc)
  where trade_type = 'SELL';

analyze trades;
