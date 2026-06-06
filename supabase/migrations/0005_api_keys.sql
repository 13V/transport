-- =========================================================================
-- API KEYS — tiered access for the paid real-time surface (SSE stream).
--
-- The public polling endpoints stay free and key-less. The push-based SSE
-- feed at /api/smart-money/live/stream REQUIRES a key that resolves to a row
-- here; the row's `tier` selects the rate limit applied per key.
--
-- PROVISION A KEY:
--   Generate a random opaque token (e.g. `openssl rand -hex 24`) and insert it.
--   Hand the raw token to the caller; they send it as either
--     Authorization: Bearer <key>
--   or ?key=<key>. Example (a 'pro' key):
--
--     insert into api_keys (key, owner_id, tier, label)
--     values ('sk_live_<random-hex>', 'someone@example.com', 'pro', 'Bot #1');
--
--   To downgrade/revoke, update the tier or delete the row:
--     update api_keys set tier = 'free' where key = 'sk_live_...';
--     delete from api_keys where key = 'sk_live_...';
-- =========================================================================

create table if not exists api_keys (
  key text primary key,
  owner_id text,
  tier text not null default 'free',
  label text,
  created_at timestamptz default now(),
  last_used_at timestamptz
);
