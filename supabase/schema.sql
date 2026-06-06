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

-- Seed/alpha labelling, populated by the wallet-first seed indexer
-- (lib/indexer/run-seed-indexer.ts). `add column if not exists` keeps this safe
-- to re-run on an existing wallet_stats table.
alter table wallet_stats add column if not exists seeded boolean not null default false;
alter table wallet_stats add column if not exists seed_source text;
create index if not exists wallet_stats_seeded_idx on wallet_stats (seeded) where seeded;

-- Accurate all-time figures, written ONLY by the wallet-first deep scan
-- (full history -> FIFO engine). `verified` marks a wallet whose numbers are
-- trustworthy "up X% all-time"; roi_pct is realized PnL / cost of sold quantity.
alter table wallet_stats add column if not exists roi_pct double precision;
alter table wallet_stats add column if not exists invested_sol double precision;
alter table wallet_stats add column if not exists verified boolean not null default false;
alter table wallet_stats add column if not exists scored_at timestamptz;
create index if not exists wallet_stats_verified_idx on wallet_stats (verified) where verified;

-- Cheap GMGN pre-screen tier (written by an external gmgn-cli job via the ingest
-- endpoint). screen_pass flags wallets worth the expensive Helius deep-scan, so
-- we only verify the promising ones instead of every captured wallet.
alter table wallet_stats add column if not exists screened_at timestamptz;
alter table wallet_stats add column if not exists screen_pass boolean not null default false;
alter table wallet_stats add column if not exists screen_profit_usd double precision;
alter table wallet_stats add column if not exists screen_win_rate double precision;
alter table wallet_stats add column if not exists screen_token_count integer;
create index if not exists wallet_stats_screen_idx on wallet_stats (screen_pass) where screen_pass;

-- Bookkeeping for the indexer (cursors, last run, etc.).
create table if not exists indexer_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Coins we've fully ingested (every swap, every wallet). Tracks graduated
-- pump.fun -> PumpSwap coins so the graduation scanner doesn't redo them.
create table if not exists coins (
  mint            text primary key,
  symbol          text,
  graduated       boolean not null default false,
  full_scanned_at timestamptz,
  trades_found    integer not null default 0,
  wallets_found   integer not null default 0,
  updated_at      timestamptz not null default now()
);
create index if not exists coins_scanned_idx on coins (full_scanned_at);

-- Daily leaderboard snapshots → rank/ROI over time, rising-wallet detection.
create table if not exists leaderboard_snapshots (
  wallet       text not null,
  day          date not null,
  rank         integer,
  score        double precision,
  roi_pct      double precision,
  realized_pnl double precision,
  captured_at  timestamptz not null default now(),
  primary key (wallet, day)
);
create index if not exists leaderboard_snapshots_day_idx on leaderboard_snapshots (day);
create index if not exists leaderboard_snapshots_wallet_idx on leaderboard_snapshots (wallet);

-- Funding graph: smart wallets that sent SOL to other wallets. A fresh wallet
-- funded by known smart money is almost always the same trader on a new wallet,
-- so we link them and track the recipient forever.
create table if not exists wallet_links (
  source     text not null,            -- the (smart) wallet that sent SOL
  target     text not null,            -- the funded wallet
  amount_sol double precision not null default 0,
  transfers  integer not null default 0,
  first_seen timestamptz,
  last_seen  timestamptz,
  updated_at timestamptz not null default now(),
  primary key (source, target)
);
create index if not exists wallet_links_source_idx on wallet_links (source);
create index if not exists wallet_links_target_idx on wallet_links (target);

-- Quick pointer on a wallet to the smart wallet that funded it (full graph in
-- wallet_links).
alter table wallet_stats add column if not exists funded_by text;

-- ============================================================================
-- INDEXER SCALING INDEXES (added for high-volume wallet ingestion/verification)
--
-- The deep-scan candidate query filters `verified = false` and orders by
-- total_trades; the older partial indexes are `WHERE verified` / `WHERE
-- screen_pass` (the WRONG polarity) so they can't serve it. These composites do,
-- turning the per-call candidate selection from a full-table sort into an index
-- range scan. Safe to re-run (`if not exists`).
-- ============================================================================
create index if not exists wallet_stats_unverified_active_idx
  on wallet_stats (verified, total_trades desc);
create index if not exists wallet_stats_screen_unverified_idx
  on wallet_stats (verified, screen_pass, total_trades desc);
-- Smart-count / curated-list prefilter (verified wallets ranked by realized PnL).
create index if not exists wallet_stats_verified_pnl_idx
  on wallet_stats (verified, realized_pnl desc);
-- Per-wallet trade-history reads (FIFO PnL recompute, holdings) without a sort.
create index if not exists trades_wallet_time_idx on trades (wallet, block_time);
