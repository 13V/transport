# ⚠️ ACTIVATION CHECKLIST — do before launch

Single source of truth for everything that must be turned on. Code is shipped;
these are the env/DB/provisioning steps that activate each feature.

## 🔴 BOT / API — DO BEFORE LAUNCH (you asked to be reminded)
The paid bot SSE stream + tiers are built but inert until you:
1. Run migration `0005_api_keys.sql` (see below).
2. Provision at least one key:
   ```sql
   insert into api_keys (key, owner_id, tier, label)
   values ('sk_live_<openssl rand -hex 24>', 'you', 'pro', 'first key');
   ```
3. Decide the model: free = public polling `/api/smart-money/live` (+ `?since` cursor);
   pro key = SSE `/api/smart-money/live/stream` (120 req/min). Tie to token-gating later if desired.
4. Smoke-test: `curl -N -H "Authorization: Bearer sk_live_..." https://<prod>/api/smart-money/live/stream`
5. Publish the `/docs` "Real-time for bots" section to integrators.

## Supabase migrations (SQL editor — all idempotent)
Run these (0004 already done): `0003_watchlist`, `0005_api_keys`, `0006_push_subscriptions`, `0007_alert_prefs`, `0008_live_bursts`.
`0008_live_bursts` powers the burst outcome-proof (per-burst returns + the hit-rate header). Without it the proof header just shows "measuring outcomes…".
(Each file under `supabase/migrations/`.)

## Cron — new outcome jobs (re-run `scripts/setup-cronjobs.ps1`, it skips existing)
Adds `persist-bursts` (2m), `measure-bursts` (5m), `daily-digest` (daily). Also retune the live `drain-shard-*` jobs to 5m via the snippet in `COST_NOTES.md`.

## Vercel env vars (then REDEPLOY — NEXT_PUBLIC_* bake in at build time)
| Feature | Vars |
|---|---|
| Telegram burst alerts | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (+ `TELEGRAM_PUBLIC_CHAT_ID` for a public channel) |
| Web push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — gen: `npx web-push generate-vapid-keys` |
| Realtime Live feed | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Webhook ingest | `HELIUS_API_KEY` (set), `HELIUS_WEBHOOK_SECRET` (random; fail-closed without it) |
| Token gating (when token launches) | `NEXT_PUBLIC_GATING_ENABLED=1`, `NEXT_PUBLIC_GATE_TOKEN_MINT`, `NEXT_PUBLIC_GATE_MIN_BALANCE` |

## Cron (cron-job.org)
- All 14 jobs created (see `scripts/setup-cronjobs.ps1`).
- Retune the live `drain-shard-*` jobs to every-5-min using the snippet in `COST_NOTES.md` (the script change only affects NEW jobs).

## Alert tuning knobs (optional, sane defaults)
`ALERT_BURST_MIN_BUYERS=4`, `ALERT_BURST_MIN_SOL=5`, `ALERT_BURST_REQUIRE_S=1`, `ALERT_BURST_COOLDOWN_MIN=30`,
`ALERT_SELL_MIN_ENTITIES=3`, `ALERT_SELL_MIN_SOL=5`, `ALERT_SELL_COOLDOWN_MIN=30`, `ALERT_WATCH_COOLDOWN_MIN=30`.

## Reference docs
`REALTIME.md`, `HELIUS_WEBHOOKS.md`, `WEBPUSH.md`, `COST_NOTES.md`, `/docs` page.
