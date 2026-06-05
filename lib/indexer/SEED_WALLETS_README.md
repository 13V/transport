# Wallet-first seed indexer

Complements the token-first scan (`run-indexer.ts`). Instead of discovering
wallets by scanning active tokens, it takes a **curated list of known alpha
wallets** and deep-scans each one's full swap history via Helius, scoring them
with the same PnL engine and upserting into `wallet_stats` flagged `seeded` so
the UI labels them **⭐ Alpha**.

## Pieces

| File | Role |
|------|------|
| `seed-wallet-list.ts` | Committed base58 address list (paste here). |
| `seed-wallets.ts` | Merges the committed list + `SEED_WALLETS` env var, validates/dedupes. |
| `wallet-history-fetcher.ts` | Pulls a wallet's full `type=SWAP` history from Helius, parses via `parseWalletTradesFromTx`. |
| `run-seed-indexer.ts` | Orchestrates: history → `trades` upsert → recompute → `wallet_stats` (seeded). |
| `../../app/api/cron/seed-wallets/route.ts` | `GET /api/cron/seed-wallets` (CRON_SECRET-protected). Also on a Vercel cron. |

The swap parser is shared: `swap-fetcher.ts` now exposes `parseWalletTradesFromTx`
(wallet-first) alongside the existing `parseTradeFromTx` (token-first), both built
on the same net-balance-delta core.

## Configuring the wallet list

Two interchangeable sources, merged and de-duplicated:

1. **Env (no deploy needed):** set `SEED_WALLETS` in Vercel to a
   comma/space/newline-separated list of base58 addresses.
2. **Code:** paste addresses into `seed-wallet-list.ts`.

## Where the list comes from (gmgn)

The companion `gmgn` bot curates profitable wallets at runtime into a **gitignored**
SQLite DB (`data/bot.db`, table `smart_wallets`) — there is no committed list to
copy. Export it from the machine where the bot ran:

```bash
# in the gmgn repo
npm run export:seed-wallets -- --format=env     # SEED_WALLETS=a,b,c  → paste into Vercel
npm run export:seed-wallets -- --format=list    # one address per line → paste into seed-wallet-list.ts
npm run export:seed-wallets -- --limit=500 --out=wallets.json
```

(or raw: `sqlite3 data/bot.db "SELECT address FROM smart_wallets WHERE is_curated=1 ORDER BY realized_profit DESC LIMIT 200;"`)

## Database migration

`run-seed-indexer` writes `wallet_stats.seeded` / `seed_source`. Apply the columns
once (idempotent) in the Supabase SQL editor — they're already in `supabase/schema.sql`:

```sql
alter table wallet_stats add column if not exists seeded boolean not null default false;
alter table wallet_stats add column if not exists seed_source text;
create index if not exists wallet_stats_seeded_idx on wallet_stats (seeded) where seeded;
```

Until that runs, the seed indexer still works — it upserts stats **without** the
flag (and the run result includes a `warning`), and the leaderboard API falls
back gracefully.

## Running

```
GET /api/cron/seed-wallets
```

Returns `{ ok, seedWallets, walletsProcessed, tradesIngested, walletsUpserted, ... }`.
With no wallets configured it's a no-op with an explanatory `error` string.
