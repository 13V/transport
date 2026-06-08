-- =========================================================================
-- 0017 — API PAYMENTS (pay-per-period API access) + api_keys.expires_at.
-- Idempotent; safe to re-run.
--
-- Backs app/api/access/pay + app/api/access/verify-payment. A user sends
-- API_PRICE_SOL (default 1 SOL) to TREASURY_WALLET on-chain; we verify the
-- transfer landed (correct recipient + amount), record the redeemed signature
-- here so it can NEVER be redeemed twice, then mint a hashed api_keys row with
-- expires_at = now + API_PERIOD_DAYS.
--
-- NON-CUSTODIAL: funds go DIRECTLY from the user's wallet to OUR treasury
-- wallet on-chain. We never hold, escrow, or move user funds — we only VERIFY a
-- transfer already landed. This table stores public tx signatures + the public
-- treasury address, no secrets.
--
-- SECURITY (matches the 0012/0015/0016 RLS lockdown pattern): touched ONLY by
-- the server via the SERVICE ROLE key. RLS ON + FORCED, NO anon/authenticated
-- policies → deny-by-default for the browser anon key.
-- =========================================================================

create table if not exists api_payments (
  -- The on-chain transfer signature. PRIMARY KEY => a signature can be redeemed
  -- at most once (insert conflicts on a replay attempt).
  signature     text             primary key,
  payer         text,
  treasury      text             not null,
  amount_sol    double precision not null,
  -- The hash of the api key minted for this payment (joins to api_keys.key).
  key_hash      text,
  owner_id      text,
  redeemed_at   timestamptz      default now()
);

alter table api_payments enable row level security;
alter table api_payments force row level security;
revoke all on table api_payments from anon, authenticated;

-- ---------------------------------------------------------------------------
-- api_keys.expires_at — paid keys expire at now + API_PERIOD_DAYS. NULL means
-- "never expires" (back-compat with existing manually-provisioned keys), and
-- validateApiKey() rejects a key whose expires_at is in the past.
-- ---------------------------------------------------------------------------
alter table api_keys add column if not exists expires_at timestamptz;
