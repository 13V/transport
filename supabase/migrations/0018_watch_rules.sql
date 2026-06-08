-- Run this in the Supabase SQL editor to enable CUSTOM ALERT RULES (watch rules).
-- Idempotent; safe to re-run. Backs app/api/watch-rules + lib/watch-eval.ts so a
-- user can define their OWN per-wallet / threshold alert rules on top of the
-- broadcast burst alerts. Each rule is owned by the same stable per-device
-- `owner` id used by watchlists / push_subscriptions / alert_prefs (generated
-- client-side, localStorage key `sm_owner_id`); it can later be swapped for a
-- connected wallet address with no schema change.
--
-- The Helius webhook's background alert step evaluates these rules against each
-- detected burst (lib/watch-eval.ts) and dispatches matches via the web-push
-- sender (lib/push.ts), respecting min_buyers / min_sol / holding_only / wallets
-- and the per-rule `muted` flag.
create table if not exists watch_rules (
  id          uuid             primary key default gen_random_uuid(),
  owner       text             not null,
  label       text,
  wallets     text[],
  min_buyers  int              default 3,
  min_sol     double precision default 0,
  holding_only boolean         default false,
  channels    text[]           default '{push}',
  created_at  timestamptz      default now(),
  muted       boolean          default false
);

-- Owner-scoped lookups (the webhook fetches all rules; the API lists by owner).
create index if not exists watch_rules_owner_idx on watch_rules (owner);

-- RLS LOCKDOWN (mirrors 0012): the public anon key ships to the browser for
-- Realtime; with RLS off PostgREST would let anyone read/write these rules. Turn
-- RLS ON + FORCE with NO anon/authenticated policies → deny-by-default. The app
-- uses the SERVICE ROLE key (lib/supabase-client.ts) which BYPASSES RLS, so
-- server access keeps working; only the public anon path is locked out.
alter table watch_rules enable row level security;
alter table watch_rules force row level security;

-- Defense in depth: strip base-table grants from the public-facing PostgREST
-- roles so even if RLS were toggled off they cannot touch this table.
revoke all on table watch_rules from anon, authenticated;
