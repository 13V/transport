-- WALLET BALANCE SNAPSHOT (drained-winner prioritization)
--
-- run-link-tracking refreshes these (Helius getMultipleAccounts, ~1 credit / 100
-- wallets) and PRIORITIZES link-scanning verified winners whose balance has gone
-- to ~0 — profits extracted / trader likely on a new wallet — so we find the
-- successor fast instead of waiting for the full-set rotation. balance_checked_at
-- drives the refresh rotation (oldest/never first); both are nullable so the code
-- degrades gracefully on a pre-0023 DB.
alter table wallet_stats add column if not exists sol_balance numeric;
alter table wallet_stats add column if not exists balance_checked_at timestamptz;

create index if not exists wallet_stats_balance_refresh_idx
  on wallet_stats (balance_checked_at nulls first)
  where verified = true;
