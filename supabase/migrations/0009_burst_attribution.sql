-- Run this in the Supabase SQL editor. Idempotent.
--
-- "Trust wedge" data foundation on top of live_bursts (migration 0008 +
-- lib/indexer/burst-outcomes.ts): adds the FULL set of buyer wallets per burst
-- for per-wallet attribution (track records, backtester) and dedupe flags so
-- auto-posted calls/results are posted at most once.
--
--   all_buyers    -- distinct smart-wallet addresses that bought in the burst,
--                    capped at 60 in lib/indexer/live-bursts.ts; refreshed as the
--                    burst grows (like buyers/sol_total/window_end).
--   posted_call   -- true once the auto-post agent has posted the call.
--   posted_result -- true once the auto-post agent has posted the outcome.
--
-- The persist cron writes all_buyers but NEVER overwrites posted_call/
-- posted_result, so the auto-post agent owns those flags.
alter table live_bursts add column if not exists all_buyers text[];
alter table live_bursts add column if not exists posted_call boolean default false;
alter table live_bursts add column if not exists posted_result boolean default false;

-- GIN index for fast "which bursts was this wallet in" attribution lookups
-- (all_buyers @> array['<wallet>']).
create index if not exists live_bursts_all_buyers_idx on live_bursts using gin (all_buyers);
