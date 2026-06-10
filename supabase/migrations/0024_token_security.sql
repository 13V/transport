-- TOKEN SECURITY (GMGN) — the rug/bundle avoidance feed.
--
-- Populated by the gmgn-token-security CI worker (gmgn-cli cannot run on
-- Vercel) via POST /api/ingest/token-security: per-token bundle/sniper rates,
-- holder concentration, honeypot/tax flags, and the creator's serial-rug
-- history. Consumed by the live-feed enrichment to flag dangerous tokens
-- loudly on burst cards. Zero Helius anywhere in this pipeline.
create table if not exists token_security (
  mint text primary key,
  bundler_rate numeric,        -- bundler wallets / holder count (0..1)
  sniper_count integer,
  top10_holder_rate numeric,   -- 0..1
  fresh_wallet_rate numeric,   -- 0..1
  bot_degen_rate numeric,      -- 0..1
  rug_ratio numeric,           -- GMGN's own rug ratio (0..1)
  is_honeypot boolean,
  buy_tax numeric,
  sell_tax numeric,
  creator text,
  creator_rug_count integer,   -- rug-pattern tokens in the creator's history
  creator_token_count integer,
  fetched_at timestamptz not null default now()
);

-- The CI worker's "what needs (re)fetching" scan orders by staleness.
create index if not exists token_security_fetched_idx on token_security (fetched_at);
