-- ============================================================================
-- SMART MONEY LEADERBOARD — DATABASE SCHEMA
-- ============================================================================
-- Run this once in your Supabase project (SQL Editor → New query → paste → Run).
-- It is idempotent: safe to re-run.
-- ============================================================================

-- Raw parsed swaps captured by the indexer. One row per (wallet, swap).
create table if not exists trades (
  id           bigint generated always as identity primary key,
  wallet       text        not null,
  token_mint   text        not null,
  trade_type   text        not null check (trade_type in ('BUY', 'SELL')),
  amount       double precision not null,          -- token amount
  price        double precision not null,          -- SOL per token
  sol_amount   double precision not null,          -- SOL value of the trade
  source       text        not null default 'JUPITER',
  tx_hash      text        not null,
  block_time   timestamptz not null,
  created_at   timestamptz not null default now(),
  unique (tx_hash, wallet, token_mint, trade_type)
);

create index if not exists trades_wallet_idx     on trades (wallet);
create index if not exists trades_token_idx      on trades (token_mint);
create index if not exists trades_block_time_idx on trades (block_time desc);

-- Precomputed per-wallet stats. The leaderboard reads ONLY this table (fast).
create table if not exists wallet_stats (
  wallet         text primary key,
  score          double precision not null default 0,
  realized_pnl   double precision not null default 0,   -- SOL
  win_rate       double precision not null default 0,   -- 0..1
  consistency    double precision not null default 0,   -- 0..1
  total_trades   integer not null default 0,
  tokens_traded  integer not null default 0,
  last_trade_at  timestamptz,
  updated_at     timestamptz not null default now()
);

create index if not exists wallet_stats_score_idx on wallet_stats (score desc);

-- Bookkeeping for the indexer (cursors, last run, etc.).
create table if not exists indexer_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
