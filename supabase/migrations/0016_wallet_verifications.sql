-- =========================================================================
-- 0016 — WALLET VERIFICATIONS. Idempotent; safe to re-run.
--
-- Backs lib/wallet-verify.ts. One row per verified Solana wallet. A wallet is
-- "verified" only after the user signs our challenge message with the wallet's
-- private key and we check the ed25519 signature server-side (non-spoofable).
--
-- A verified wallet can be bound to a Telegram chat_id AND/OR a browser
-- web_session id, so the same wallet drives BOTH the Telegram (>=1M hold) and
-- the web premium (>=500k hold) gates. last_balance / last_checked cache the
-- most recent on-chain gate-token balance read so we can show "balance dropped"
-- notices without re-reading on every broadcast.
--
-- NON-CUSTODIAL: we only ever store a PUBLIC key (the wallet address) and a
-- proof-of-ownership signature result. No private keys, no funds — ever.
--
-- SECURITY (matches the 0012/0015 RLS lockdown pattern): per-user data touched
-- ONLY by the server via the SERVICE ROLE key (which BYPASSES RLS). RLS is ON
-- and FORCED with NO anon/authenticated policies → deny-by-default for the
-- public anon key that ships to the browser.
-- =========================================================================

create table if not exists wallet_verifications (
  wallet        text             primary key,
  chat_id       text,
  web_session   text,
  verified_at   timestamptz      default now(),
  last_balance  double precision,
  last_checked  timestamptz
);

-- Fast reverse lookups: "which wallet is bound to this chat / this session?".
-- A chat or session binds to at most one wallet (last verify wins via upsert),
-- so a partial unique index keeps the binding 1:1 and the lookup index-only.
create unique index if not exists wallet_verifications_chat_id_uidx
  on wallet_verifications (chat_id)
  where chat_id is not null;

create unique index if not exists wallet_verifications_web_session_uidx
  on wallet_verifications (web_session)
  where web_session is not null;

-- Lock RLS on (and FORCE it so the owner is subject to it too); add NO policies
-- so anon/authenticated are denied by default. Service role bypasses RLS, so the
-- server keeps full read/write. Idempotent: ENABLE/FORCE are no-ops when set.
alter table wallet_verifications enable row level security;
alter table wallet_verifications force row level security;

-- Defense in depth: strip base-table grants from the public-facing roles so the
-- anon/authenticated PostgREST roles cannot touch this table even if RLS were
-- somehow toggled off.
revoke all on table wallet_verifications from anon, authenticated;
