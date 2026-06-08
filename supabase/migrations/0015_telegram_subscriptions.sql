-- =========================================================================
-- 0015 — TELEGRAM BOT PER-USER SUBSCRIPTIONS. Idempotent; safe to re-run.
--
-- Backs the inbound Telegram BOT (app/api/telegram/webhook/route.ts +
-- lib/alerts/telegram-bot.ts). One row per chat that has /start-ed the bot.
-- Each chat carries its own alert filters so broadcastBurst() can fan a
-- high-conviction burst out only to the subscribers it matches.
--
-- SECURITY (matches the 0012 RLS lockdown pattern): this table holds per-user
-- data and is touched ONLY by the server via the SERVICE ROLE key, which
-- BYPASSES RLS. We turn RLS ON and FORCE it, and add NO anon/authenticated
-- policies → deny-by-default for the public anon key that ships to the browser.
-- =========================================================================

create table if not exists telegram_subscriptions (
  chat_id         text             primary key,
  created_at      timestamptz      default now(),
  -- Per-chat filters. Defaults mirror the public conviction bar's lower bound
  -- so a fresh /start gets sensible (not spammy) alerts out of the box.
  min_buyers      int              default 3,
  min_sol         double precision default 0,
  holding_only    boolean          default false,
  muted           boolean          default false,
  -- When non-empty, the chat ALSO receives any burst whose buyers include one
  -- of these wallets, regardless of the min_* thresholds.
  watched_wallets text[]
);

-- Lock RLS on (and FORCE it so the owner is subject to it too); add NO policies
-- so anon/authenticated are denied by default. Service role bypasses RLS, so the
-- server keeps full read/write. Idempotent: ENABLE/FORCE are no-ops when set.
alter table telegram_subscriptions enable row level security;
alter table telegram_subscriptions force row level security;

-- Defense in depth: strip base-table grants from the public-facing roles so the
-- anon/authenticated PostgREST roles cannot touch this table even if RLS were
-- somehow toggled off.
revoke all on table telegram_subscriptions from anon, authenticated;
