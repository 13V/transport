-- =========================================================================
-- 0020 — VERIFY NONCES (signature-replay + binding-spoof fix). Idempotent;
-- safe to re-run.
--
-- Backs app/api/access/verify-wallet's server-issued challenge flow. FINDING
-- C-1: the challenge nonce used to be generated CLIENT-side and the signed
-- message did NOT include the binding target, so a captured signature could be
-- replayed to bind a victim's wallet to ANY attacker-chosen session/chat.
--
-- The fix issues the nonce SERVER-side, stores it here bound to the EXACT
-- target it may be used for, gives it a short TTL, and marks it `used` on
-- redemption so each challenge is single-use:
--   - nonce        : the server-generated, cryptographically-random nonce (PK).
--   - product      : 'web' | 'telegram' | 'api' — the gate this challenge is for.
--   - target       : the session id OR chat id this challenge is bound to.
--   - target_kind  : 'web' (web_session) | 'telegram' (chat_id).
--   - expires_at   : short TTL (verify-wallet issues ~5 min); past => rejected.
--   - used         : flipped true on successful verify => single-use (no replay).
--
-- verify-wallet rebuilds the signed message from THIS stored row (never from
-- client input), so the body's session/chatId is proven, not spoofable.
--
-- SECURITY (matches the 0012/0016/0017 RLS lockdown pattern): touched ONLY by
-- the server via the SERVICE ROLE key (which BYPASSES RLS). RLS ON + FORCED,
-- NO anon/authenticated policies => deny-by-default for the browser anon key.
-- =========================================================================

create table if not exists verify_nonces (
  nonce        text             primary key,
  product      text             not null,
  target       text             not null,
  target_kind  text             not null,
  expires_at   timestamptz      not null,
  used         boolean          default false,
  created_at   timestamptz      default now()
);

-- Cleanup / expiry scans walk by expires_at.
create index if not exists verify_nonces_expires_at_idx
  on verify_nonces (expires_at);

-- Lock RLS on (and FORCE it so the owner is subject to it too); add NO policies
-- so anon/authenticated are denied by default. Service role bypasses RLS, so the
-- server keeps full read/write. Idempotent: ENABLE/FORCE are no-ops when set.
alter table verify_nonces enable row level security;
alter table verify_nonces force row level security;

-- Defense in depth: strip base-table grants from the public-facing roles so the
-- anon/authenticated PostgREST roles cannot touch this table even if RLS were
-- somehow toggled off.
revoke all on table verify_nonces from anon, authenticated;
