-- =========================================================================
-- 0012 — RLS LOCKDOWN (CRITICAL SECURITY FIX). Idempotent; safe to re-run.
--
-- WHY: the public anon key ships to the browser (lib/supabase-browser.ts) for
-- Realtime. With RLS DISABLED on a table, PostgREST + that anon key let ANYONE
-- read/write the table directly (e.g. dump the plaintext `api_keys` for free
-- pro access, or read/tamper with every user's watchlists / push_subscriptions
-- / alert_prefs). PostgREST honors RLS, so the fix is: turn RLS ON for every
-- user/secret table and add NO anon/authenticated policies → deny by default.
--
-- The app reads/writes these tables with the SERVICE ROLE key (server-side,
-- lib/supabase-client.ts), which BYPASSES RLS entirely — so server access keeps
-- working unchanged. Only the public anon path is locked out.
--
-- !!! `trades` IS DELIBERATELY EXCLUDED !!!
-- The browser LiveFeed subscribes to `trades` via Supabase Realtime on the anon
-- client. Its RLS, its public-read policy, and its realtime publication are set
-- up in 0004_realtime_trades.sql and MUST stay exactly as-is. This migration
-- does NOT touch `trades`, its policy, or the supabase_realtime publication.
-- =========================================================================

do $$
declare
  t text;
  -- Every non-`trades` user/secret table that currently lacks RLS. Locking RLS
  -- on with no policies = deny-by-default for anon/authenticated; service role
  -- still bypasses. `to_regclass` guards tables that may not exist in a given
  -- environment so this stays idempotent and order-independent.
  tables text[] := array[
    -- secret / paid-access
    'api_keys',
    -- per-user data (per-device owner_id today)
    'watchlists',
    'push_subscriptions',
    'alert_prefs',
    -- indexer / internal datasets
    'live_bursts',
    'indexer_state',
    'wallet_stats',
    'wallet_links',
    'coins',
    'leaderboard_snapshots'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      -- Force RLS so even the table owner is subject to it; service role still
      -- bypasses (it is BYPASSRLS), so server access is unaffected.
      execute format('alter table public.%I force row level security', t);
    end if;
  end loop;
end $$;

-- Defense in depth for the most sensitive table: even if RLS were somehow
-- toggled off again, strip the base table grants from the public-facing roles so
-- the anon/authenticated PostgREST roles cannot select/insert/update/delete it.
revoke all on table api_keys from anon, authenticated;
