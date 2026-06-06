-- Run this in the Supabase SQL editor to enable browser/desktop web-push alerts.
-- Idempotent. Backs lib/push.ts + app/api/push/subscribe so web users can opt in
-- to real-time burst alerts (the 🔔 Alerts button in the Live feed) without
-- Telegram. The Helius webhook's burst-alert step fans out to every row here.
--
-- owner_id is the SAME stable per-device id used for the watchlist (generated
-- client-side, stored in localStorage as `sm_owner_id`). It can later be swapped
-- for a connected wallet address without a schema change.
--
-- The endpoint is the natural primary key: each browser/PushManager subscription
-- has exactly one endpoint URL, so re-subscribing the same device upserts cleanly.
create table if not exists push_subscriptions (
  endpoint   text        primary key,
  owner_id   text,
  p256dh     text        not null,
  auth       text        not null,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_owner_idx on push_subscriptions (owner_id);
