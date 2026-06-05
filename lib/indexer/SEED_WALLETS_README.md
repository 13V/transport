# Smart-wallet list (curation + export)

The product: a **curated list of smart wallets** users can drop into a trading
terminal watchlist or a Telegram alert bot. transport discovers wallets itself
(token-first scan), refines their scores, applies a quality gate, and exposes
the result as a consumable list — no external/gmgn dependency.

## Pipeline

1. **Discover** (`run-indexer.ts`, token-first) — scan active tokens, attribute
   swaps to wallets, populate `wallet_stats`. (Pre-existing.)
2. **Refine** (`run-seed-indexer.ts`, wallet-first) — deep-scan the top wallets'
   *full* swap history via Helius so their score reflects everything they've
   traded, not just trades on tokens the scan happened to pick.
3. **Curate** (`curation.ts`) — `isSmartWallet()` quality gate decides who's
   actually "smart" (anti-gaming win-rate cap, PnL/activity floors).
4. **Export** (`/api/smart-money/list`) — the curated list as JSON / addresses / CSV.

## Files

| File | Role |
|------|------|
| `curation.ts` | `isSmartWallet()` + env-tunable `SmartCriteria` — the definition of "smart". |
| `wallet-history-fetcher.ts` | Pulls a wallet's full `type=SWAP` history from Helius. |
| `run-seed-indexer.ts` | Deep-scans wallets (our own top candidates by default; manual list if configured) and re-scores them. |
| `seed-wallets.ts` / `seed-wallet-list.ts` | Optional manual additions via `SEED_WALLETS` env or committed list. |
| `../../app/api/cron/seed-wallets/route.ts` | `GET /api/cron/seed-wallets` — runs the refine pass (also on a Vercel cron). |
| `../../app/api/smart-money/list/route.ts` | `GET /api/smart-money/list` — the export surface. |

The swap parser is shared: `swap-fetcher.ts` exposes `parseWalletTradesFromTx`
(wallet-first) alongside `parseTradeFromTx` (token-first), both on the same
net-balance-delta core.

## Export — what users consume

```
GET /api/smart-money/list                  → JSON { count, criteria, wallets[] }
GET /api/smart-money/list?format=addresses → one base58 address per line (watchlist import)
GET /api/smart-money/list?format=csv       → address + stats
GET /api/smart-money/list?limit=100        → cap results (default 200, max 1000)
```

The leaderboard UI also has a **"Copy smart wallet list"** button (plain
addresses → clipboard) and a **CSV** download. Smart wallets show a **Smart**
badge; manually-trusted ones show **⭐ Smart**.

A Telegram alert bot just polls the JSON/addresses endpoint on an interval and
diffs the set to alert on new entrants.

## The "smart" bar (tunable via env)

| Env | Default | Meaning |
|-----|---------|---------|
| `SMART_MIN_PNL_SOL` | 5 | realized PnL floor (SOL) |
| `SMART_MIN_WIN_RATE` | 0.45 | win-rate floor |
| `SMART_MAX_WIN_RATE` | 0.95 | win-rate cap (rejects stat-farmers) |
| `SMART_MIN_TRADES` | 15 | minimum trades |
| `SMART_MIN_TOKENS` | 4 | minimum distinct tokens |
| `SMART_MIN_SCORE` | 0 | composite score floor (0–100) |
| `SMART_MAX_IDLE_DAYS` | 45 | must have traded within this window (0 = off) |

## Manual additions (optional)

To force-include hand-picked wallets (they bypass the gate and show ⭐):
set `SEED_WALLETS` (comma/space/newline base58) in Vercel, or paste into
`seed-wallet-list.ts`. With no manual list, the refine pass auto-sources our own
top-discovered wallets.

## Database

`run-seed-indexer` optionally writes `wallet_stats.seeded` / `seed_source` (for
manual additions). Apply once in the Supabase SQL editor (idempotent; already in
`supabase/schema.sql`):

```sql
alter table wallet_stats add column if not exists seeded boolean not null default false;
alter table wallet_stats add column if not exists seed_source text;
create index if not exists wallet_stats_seeded_idx on wallet_stats (seeded) where seeded;
```

Curation itself needs **no** migration — it's computed at read time from existing
stats, so the export works the moment the token-first indexer has populated data.
