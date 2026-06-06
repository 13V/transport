-- Run this in the Supabase SQL editor to speed up high-volume indexing.
-- Idempotent. See app/api/status (migrationApplied) for verification.
create index if not exists wallet_stats_unverified_active_idx
  on wallet_stats (verified, total_trades desc);
create index if not exists wallet_stats_screen_unverified_idx
  on wallet_stats (verified, screen_pass, total_trades desc);
create index if not exists wallet_stats_verified_pnl_idx
  on wallet_stats (verified, realized_pnl desc);
create index if not exists trades_wallet_time_idx on trades (wallet, block_time);
