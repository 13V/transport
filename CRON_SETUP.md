# Reliable scheduling with an external cron (cron-job.org)

GitHub Actions cron is **best-effort** — under load it delays, clusters, or drops
scheduled runs entirely (we've observed multi-hour gaps). That starves the
pipeline even though every endpoint works. An external cron service pings the
endpoints on a dependable schedule and fixes that.

The cron endpoints are designed for this: each call is bounded (≤60s Vercel
function), idempotent, `CRON_SECRET`-protected, and the heavy ones are
**shard-aware** (`?shard=N&shards=K`) so you can run several in parallel.

> ⚠️ **Pick ONE driver to control Helius spend.** If you switch to cron-job.org,
> disable the GitHub Actions schedules (comment out the `on.schedule:` block in
> `.github/workflows/indexer-cron.yml`, keep `workflow_dispatch` for manual runs)
> so the pipeline isn't running twice and double-billing Helius. (I can do that
> for you on request.)

## Setup (cron-job.org, ~5 min)

1. Create a free account at https://cron-job.org.
2. For every job below: **Create cronjob** → set the **URL**, **schedule**, and
   under **Advanced → Headers** add:
   `Authorization: Bearer <YOUR_CRON_SECRET>` (the same value set in Vercel).
   Method **GET**, request timeout **60s**, enable "save responses" to debug.

Replace `BASE` with your production URL: `https://transport-topaz-eight.vercel.app`

### Deep-scan drain (verify wallets) — 4 parallel shards, every 1 min
Create 4 jobs (this is the highest-throughput part):

| URL | Every |
|---|---|
| `BASE/api/cron/seed-wallets?maxWallets=30&shard=0&shards=4` | 1 min |
| `BASE/api/cron/seed-wallets?maxWallets=30&shard=1&shards=4` | 1 min |
| `BASE/api/cron/seed-wallets?maxWallets=30&shard=2&shards=4` | 1 min |
| `BASE/api/cron/seed-wallets?maxWallets=30&shard=3&shards=4` | 1 min |

≈ 4 shards × 60 calls/hr × 30 = ~7,200 wallet-scans/hr (drains the backlog).

### Discovery (ingest NEW wallets) — feeds the drain
| URL | Every |
|---|---|
| `BASE/api/cron/index?maxTokens=30` | 2 min |
| `BASE/api/cron/graduations?maxCoins=8&shard=0&shards=3` | 3 min |
| `BASE/api/cron/graduations?maxCoins=8&shard=1&shards=3` | 3 min |
| `BASE/api/cron/graduations?maxCoins=8&shard=2&shards=3` | 3 min |
| `BASE/api/cron/chain-discovery` | 30 min |
| `BASE/api/cron/track-links` | 6 h |

### Signals & housekeeping
| URL | Every |
|---|---|
| `BASE/api/cron/alerts` | 5 min |
| `BASE/api/cron/growth-alert` | 1 h |
| `BASE/api/cron/snapshot` | 1 h |

## Tuning
- More drain throughput → add shards (e.g. `shards=6`, create 6 jobs) or raise
  `maxWallets` (≤60; bounded by the 60s function).
- Cut Helius spend → fewer shards / longer intervals.
- Watch the "save responses" output: `walletsProcessed` (drain),
  `walletsCaptured` (index/graduations), `coinsScanned` (graduations).

## Alternatives
- **QStash (Upstash)** — similar, with signing/retries; more robust but needs a
  signature-verify step in the routes.
- **Vercel Cron** — most integrated, but the **Hobby plan caps cron at once/day**;
  only viable on **Pro** (which also unlocks 300s functions = ~5× more work per
  call — the single biggest throughput upgrade if you want it).
