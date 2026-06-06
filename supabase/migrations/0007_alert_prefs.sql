-- Run this in the Supabase SQL editor to enable per-user alert preferences.
-- Idempotent. Backs app/api/alert-prefs so each owner can tune their alert
-- thresholds and mute/unmute. The Helius webhook honors `muted` for per-user
-- watchlist pushes today; the threshold columns are the foundation for full
-- per-owner fan-out.
--
-- owner_id is the SAME stable per-device id used for the watchlist and web-push
-- subscriptions (generated client-side, stored in localStorage as `sm_owner_id`).
-- It can later be swapped for a connected wallet address without a schema change.
create table if not exists alert_prefs (
  owner_id        text             primary key,
  min_buyers      int              not null default 4,
  min_sol         double precision not null default 5,
  require_s       boolean          not null default true,
  exit_alerts     boolean          not null default true,
  muted           boolean          not null default false,
  telegram_chat_id text,
  created_at      timestamptz      not null default now()
);
