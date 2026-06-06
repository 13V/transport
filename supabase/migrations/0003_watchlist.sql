-- Run this in the Supabase SQL editor to enable the server-side watchlist.
-- Idempotent. Backs lib/useWatchlist.ts (via app/api/watchlist) so a user's
-- watched wallets survive across devices and can later power per-user alerts.
--
-- owner_id is a stable per-device UUID today (generated client-side, stored in
-- localStorage as `sm_owner_id`). It can later be swapped for a connected wallet
-- address (token-gating identity) without a schema change.
create table if not exists watchlists (
  owner_id   text        not null,
  address    text        not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, address)
);

create index if not exists watchlists_owner_idx on watchlists (owner_id);
