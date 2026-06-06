# Smart Money — Operator & Developer Guide

A Solana smart-money tracking system. It discovers profitable wallets from
real on-chain swap history, computes an **accurate all-time realized FIFO ROI**
from each wallet's full Helius history, curates a trustworthy "smart-money"
list, follows the funding graph to track traders across wallets, and fires
alerts when smart money buys.

---

## 1. What it is

The product framing is simple: **"this wallet is up X% all-time"**.

- **Discovers** profitable Solana wallets by ingesting the full swap history of
  active/graduated coins (and by following proven winners and their funding
  links).
- **Computes accurate ROI**: every candidate wallet is deep-scanned over its
  full Helius history and replayed through a single FIFO cost-basis engine
  (`lib/indexer/accurate-pnl.ts`). The headline number is **realized PnL ÷ cost
  of the quantity actually sold**.
- **Curates** a smart-money list via an ROI-centric quality gate plus a
  conservative bot/MEV/arb exclusion filter (`curation.ts` + `bot-filter.ts`).
- **Tracks wallet funding links**: follows SOL out of winners to find the
  trader's other/fresh wallets and keeps tracking them "forever"
  (`wallet-links.ts`, `clusters.ts`).
- **Alerts**: pushes new smart-money buys and new funding links to Telegram /
  webhook.

Everything is bounded per run so it fits the serverless time budget; the
leaderboard fills out over successive cron runs.

---

## 2. Architecture / data flow

Three quality tiers exist in `wallet_stats`:

| Tier | Meaning | Set by |
|------|---------|--------|
| **Pool (indexed)** | Captured candidate; a stub or window-only row. `walletsIndexed` counts these. | graduation / chain / token-first capture |
| **Verified** | Deep-scanned over full history → trustworthy all-time `roi_pct`. `verified=true`. | seed/deep-scan worker (`run-seed-indexer`) |
| **Smart** | Verified AND clears the curation ROI gate AND survives the bot filter (or manually `seeded`). | computed on read via `curation.isSmartWallet` |

`smartWallets ⊆ verifiedWallets ⊆ walletsIndexed`. "Smart" is computed at read
time from the gate knobs — it is not a stored column, so moving the thresholds
re-curates instantly with no re-scan.

### Pipeline

```
            DISCOVER (grow the candidate pool)
  ┌───────────────────────────────────────────────────────┐
  │ token-first index   graduated-coin     chain discovery │
  │ (run-indexer)       full capture       (follow winners)│
  │                     (graduations)      (run-chain-disc) │
  │                          │                              │
  │                     link tracking (follow SOL out of    │
  │                     winners → fresh wallets)            │
  └───────────────────────────┬───────────────────────────┘
                              │  stub wallet_stats rows (verified=false)
                              ▼
            [ optional ] GMGN cheap screen  (gmgn-cli on VPS
                         → POST /api/ingest/wallet-stats)
                         flags screen_pass = worth verifying
                              │
                              ▼
            VERIFY (drain backlog → accurate ROI)
            run-seed-indexer → accurate-pnl (FIFO)
            writes roi_pct / invested_sol / verified=true
                              │
                              ▼
            CURATE   isSmartWallet (ROI gate) + detectBot (exclude)
                              │
                              ▼
            SURFACE  /api/smart-money/list  · /smart-money board
                     /api/smart-money/buying · wallet profiles/clusters
                              │
                              ▼
            ALERT    /api/cron/alerts → Telegram / webhook
```

- **Discover** widens the funnel: graduated-coin full capture is the front of
  the funnel (scales the pool into the thousands); chain discovery and link
  tracking are higher-signal because they follow proven winners.
- **Verify** is the expensive Helius step. The deep-scan worker prioritises
  GMGN-screened (`screen_pass`) wallets, then the general unverified backlog
  (most-active first), then falls back to top-by-score.
- Verified wallets are never overwritten by the windowed token-first indexer.

---

## 3. The cron jobs

Driven by GitHub Actions (`.github/workflows/indexer-cron.yml`), which pings the
deployed API on a schedule (Vercel Hobby cron is capped at once/day; GitHub
Actions is not, and adds a manual **Run workflow** button that runs everything).
All schedules are UTC. `BASE_URL` is set in the workflow; each call sends
`Authorization: Bearer ${{ secrets.CRON_SECRET }}`.

| Job | Schedule (cron) | Frequency | Does | Endpoint |
|-----|-----------------|-----------|------|----------|
| `alerts` | `*/15 * * * *` | every 15 min | Fire alerts for new smart buys / new fundings | `GET /api/cron/alerts` |
| `index` | `0 */2 * * *` | every 2 h | Token-first index (discover wallets via active tokens) | `GET /api/cron/index` |
| `refine` | `30 */1 * * *` | hourly | Drain deep-scan backlog → verify wallets (accurate ROI) | `GET /api/cron/seed-wallets` |
| `graduations` | `15 */3 * * *` | every 3 h | Capture graduated coins in full (every wallet) | `GET /api/cron/graduations` |
| `chain-discovery` | `45 */6 * * *` | every 6 h | Follow proven winners into the coins they bought | `GET /api/cron/chain-discovery` |
| `track-links` | `30 */6 * * *` | every 6 h | Follow SOL out of winners → discover their other wallets | `GET /api/cron/track-links` |

There is also `GET /api/cron/snapshot` (daily leaderboard snapshot for
ROI/rank-over-time) — wire it to a once/day schedule if you want history charts.

**GMGN screen** (`.github/workflows/gmgn-screen.yml`) is a separate, **manual-only**
workflow (the scheduled trigger is commented out until `gmgn-cli` is installed on
a runner/VPS). It screens backlog wallets cheaply via GMGN and POSTs results to
the ingest endpoint.

---

## 4. API endpoints

### Smart-money surfaces
- `GET /api/smart-money` — top-100 leaderboard from `wallet_stats` (paginated `?limit`/`?offset`, cached). Also resolves `/{address}` (wallet details) and `/history`.
- `GET /api/smart-money/list` — curated smart-wallet export. `?format=json|addresses|csv`, `?limit` (default 200, max 1000), `?verified=0` to include unverified, `?sort=roi`, `?gate=0` to skip the curation filter.
- `GET /api/smart-money/buying` — tokens multiple verified smart wallets are buying now. `?hours` (1..168, default 24), `?limit` (1..200, default 50).
- `GET /api/smart-money/discover` — live on-demand discovery (no DB/cron, Helius only). `?coins` (max 25), `?depth` (max 1000), `?min_coins`, `?min_pnl`, `?limit`, `?format`. Takes ~30–60s.

### Status
- `GET /api/status` — whole-system health: last index/refine runs, totals (`walletsIndexed` / `smartWallets` / `verifiedWallets`), `migrationApplied`, active criteria, and the top curated wallets.

### Token surfaces
- `GET /api/token/{mint}/traders` — rank every wallet that traded a coin by realized PnL on it. `?max`, `?limit`, `?sort=total|realized`, `?min_pnl`, `?winners=1`.
- `GET /api/token/{mint}/smart-holders` — intersect a coin's traders with the verified smart-money set; pairs all-time ROI with PnL on this coin. `?max`.
- `GET /api/tokens/recent` — recently-indexed mints (pump.fun coins first). `?limit` (max 100), `?pump=1`.

### Wallet surfaces
- `GET /api/wallet/{address}/profile` — rich detail: cached stats, per-token PnL breakdown (best/worst via FIFO), recent activity, funding cluster.
- `GET /api/wallet/{address}/score` — accurate all-time realized PnL / invested / ROI from full history. `?max` (100..3000, default 1500).
- `GET /api/wallet/{address}/holdings` — current holdings marked to market for unrealized PnL.
- `GET /api/wallet/{address}/history` — daily leaderboard snapshots (rank/score/ROI over time). `?days=90`.
- `GET /api/wallet/{address}/links` — funding graph around a wallet (who it funded, who funded it).
- `GET /api/wallet/{address}/cluster` — the wallet's whole on-chain entity (connected component of the funding graph) with each member's ROI.

### Cron (CRON_SECRET-protected when set)
- `GET /api/cron/index` — token-first indexer.
- `GET /api/cron/seed-wallets` — deep-scan / verify (drain backlog or seed list).
- `GET /api/cron/graduations` — graduated-coin full capture.
- `GET /api/cron/chain-discovery` — follow proven winners.
- `GET /api/cron/track-links` — link tracking.
- `GET /api/cron/alerts` — detect & push alerts.
- `GET /api/cron/snapshot` — daily leaderboard snapshot.

### Ingest (CRON_SECRET-protected when set)
- `GET /api/ingest/wallet-stats?limit=200` — addresses still needing a GMGN screen.
- `POST /api/ingest/wallet-stats` — body `{ source, wallets: [{ address, winRate?, realizedProfitUsd?, tokenCount?, ... }] }`; stores screen tier and flags `screen_pass`.

### Other
- `POST /api/analyze` — token insider report (creator / clusters / snipers / smart-money detectors). Rate-limited 10/min/IP.

---

## 5. Database schema

Tables (all in `supabase/schema.sql`; the migration is idempotent):

- **`trades`** — raw parsed swaps, one row per `(wallet, swap)`. Columns:
  `id, wallet, token_mint, trade_type ('BUY'|'SELL'), amount, price (SOL/token),
  sol_amount, source, tx_hash, block_time, created_at`. Unique on
  `(tx_hash, wallet, token_mint, trade_type)`.
- **`wallet_stats`** — precomputed per-wallet stats; the leaderboard reads ONLY
  this table. Columns:
  - base: `wallet (pk), score, realized_pnl, win_rate, consistency,
    total_trades, tokens_traded, last_trade_at, updated_at`
  - seed: `seeded, seed_source`
  - accurate (deep-scan): `roi_pct, invested_sol, verified, scored_at`
  - GMGN screen: `screened_at, screen_pass, screen_profit_usd,
    screen_win_rate, screen_token_count`
  - funding: `funded_by`
- **`wallet_links`** — funding graph edges: `source, target, amount_sol,
  transfers, first_seen, last_seen, updated_at`, pk `(source, target)`.
- **`coins`** — fully-ingested coins: `mint (pk), symbol, graduated,
  full_scanned_at, trades_found, wallets_found, updated_at`.
- **`indexer_state`** — bookkeeping cursors / last-run records: `key (pk),
  value (jsonb), updated_at` (keys: `last_run`, `last_seed_run`,
  `last_graduation_scan`, `last_chain_discovery`, `last_link_tracking`).
- **`leaderboard_snapshots`** — daily history: `wallet, day, rank, score,
  roi_pct, realized_pnl, captured_at`, pk `(wallet, day)`. (Created by the
  snapshots migration below, not the main `schema.sql`.)

### Consolidated migration

Run once in the Supabase SQL editor:

```sql
-- Raw parsed swaps. One row per (wallet, swap).
create table if not exists trades (
  id           bigint generated always as identity primary key,
  wallet       text        not null,
  token_mint   text        not null,
  trade_type   text        not null check (trade_type in ('BUY', 'SELL')),
  amount       double precision not null,
  price        double precision not null,
  sol_amount   double precision not null,
  source       text        not null default 'JUPITER',
  tx_hash      text        not null,
  block_time   timestamptz not null,
  created_at   timestamptz not null default now(),
  unique (tx_hash, wallet, token_mint, trade_type)
);
create index if not exists trades_wallet_idx     on trades (wallet);
create index if not exists trades_token_idx      on trades (token_mint);
create index if not exists trades_block_time_idx on trades (block_time desc);

-- Precomputed per-wallet stats (the leaderboard reads ONLY this).
create table if not exists wallet_stats (
  wallet         text primary key,
  score          double precision not null default 0,
  realized_pnl   double precision not null default 0,
  win_rate       double precision not null default 0,
  consistency    double precision not null default 0,
  total_trades   integer not null default 0,
  tokens_traded  integer not null default 0,
  last_trade_at  timestamptz,
  updated_at     timestamptz not null default now()
);
create index if not exists wallet_stats_score_idx on wallet_stats (score desc);

-- Seed labelling.
alter table wallet_stats add column if not exists seeded boolean not null default false;
alter table wallet_stats add column if not exists seed_source text;
create index if not exists wallet_stats_seeded_idx on wallet_stats (seeded) where seeded;

-- Accurate all-time figures (deep scan → FIFO engine).
alter table wallet_stats add column if not exists roi_pct double precision;
alter table wallet_stats add column if not exists invested_sol double precision;
alter table wallet_stats add column if not exists verified boolean not null default false;
alter table wallet_stats add column if not exists scored_at timestamptz;
create index if not exists wallet_stats_verified_idx on wallet_stats (verified) where verified;

-- Cheap GMGN pre-screen tier.
alter table wallet_stats add column if not exists screened_at timestamptz;
alter table wallet_stats add column if not exists screen_pass boolean not null default false;
alter table wallet_stats add column if not exists screen_profit_usd double precision;
alter table wallet_stats add column if not exists screen_win_rate double precision;
alter table wallet_stats add column if not exists screen_token_count integer;
create index if not exists wallet_stats_screen_idx on wallet_stats (screen_pass) where screen_pass;

-- Funding pointer.
alter table wallet_stats add column if not exists funded_by text;

-- Indexer bookkeeping.
create table if not exists indexer_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Fully-ingested coins.
create table if not exists coins (
  mint            text primary key,
  symbol          text,
  graduated       boolean not null default false,
  full_scanned_at timestamptz,
  trades_found    integer not null default 0,
  wallets_found   integer not null default 0,
  updated_at      timestamptz not null default now()
);
create index if not exists coins_scanned_idx on coins (full_scanned_at);

-- Funding graph edges.
create table if not exists wallet_links (
  source     text not null,
  target     text not null,
  amount_sol double precision not null default 0,
  transfers  integer not null default 0,
  first_seen timestamptz,
  last_seen  timestamptz,
  updated_at timestamptz not null default now(),
  primary key (source, target)
);
create index if not exists wallet_links_source_idx on wallet_links (source);
create index if not exists wallet_links_target_idx on wallet_links (target);

-- Daily leaderboard history (for /history charts).
create table if not exists leaderboard_snapshots (
  wallet       text not null,
  day          date not null,
  rank         integer,
  score        double precision,
  roi_pct      double precision,
  realized_pnl double precision,
  captured_at  timestamptz not null default now(),
  primary key (wallet, day)
);
create index if not exists leaderboard_snapshots_day_idx    on leaderboard_snapshots (day);
create index if not exists leaderboard_snapshots_wallet_idx on leaderboard_snapshots (wallet);
```

---

## 6. Configuration

All defaults match the code. Throttle knobs accept a **positive integer** (else
the fallback is used).

### Core / required

| Var | Default | Purpose |
|-----|---------|---------|
| `HELIUS_API_KEY` | — | Paid Helius key; fetches real swaps & transfers. Required for indexer/discover. |
| `SUPABASE_URL` | — | Supabase project URL. Required for persistence. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service-role key (server-side, secret). Required. |
| `CRON_SECRET` | — (open) | If set, cron + ingest endpoints require `Authorization: Bearer <secret>`. |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | App base URL. |

### Smart-money curation gate (`curation.ts`)

| Var | Default | Purpose |
|-----|---------|---------|
| `SMART_MIN_ROI_PCT` | `0` | All-time realized ROI% floor (requires an accurate ROI). |
| `SMART_MIN_PNL_SOL` | `1` | Realized PnL floor (SOL) — keeps out tiny-size noise. |
| `SMART_MIN_INVESTED_SOL` | `0` (off) | Min capital deployed so ROI% is on real size. |
| `SMART_MIN_TRADES` | `10` | Min total trades. |
| `SMART_MIN_TOKENS` | `3` | Min distinct tokens. |
| `SMART_MAX_WIN_RATE` | `1` (off) | Upper win-rate cap to reject stat-farmers. |
| `SMART_MAX_IDLE_DAYS` | `45` | Must have traded within this window (0 = no limit). |
| `SMART_ALLOW_BOTS` | unset | Set to `1` to disable the bot/MEV/arb exclusion. |

### Helius cost throttles

| Var | Default | Purpose |
|-----|---------|---------|
| `SEED_MAX_WALLETS` | `30` | Wallets verified (deep-scanned) per run. |
| `SEED_MAX_TXS` | `500` | Max history txs pulled per wallet. |
| `SEED_TIME_BUDGET_MS` | `50000` | Per-run time budget for the deep scan. |
| `SCAN_MIN_TRADES` | `0` | Skip backlog wallets below this many trades. |
| `GRAD_MAX_COINS` | `3` | Graduated coins fully ingested per run. |
| `GRAD_MAX_TXS` | `3000` | Max history txs per coin. |
| `GRAD_MIN_TXNS24H` | `300` | Min 24h trade count for a coin to be worth full-scanning. |
| `GRAD_TIME_BUDGET_MS` | `50000` | Per-run time budget for graduation scan. |
| `CHAIN_MAX_WINNERS` | `30` | Top verified wallets to follow. |
| `CHAIN_MAX_COINS` | `4` | Coins to fully scan per run. |
| `CHAIN_MAX_TXS` | `3000` | Max history txs per followed coin. |
| `CHAIN_TIME_BUDGET_MS` | `50000` | Per-run time budget for chain discovery. |
| `INDEX_MAX_TOKENS` | `15` | Tokens scanned per token-first run. |
| `INDEX_SWAPS_PER_TOKEN` | `100` | Swaps pulled per token. |
| `INDEX_TIME_BUDGET_MS` | `50000` | Per-run time budget for token-first index. |
| `LINK_MAX_WALLETS` | `20` | Winners scanned for SOL distributions per run. |
| `LINK_MIN_SOL` | `0.5` | Min SOL transfer to count as funding. |
| `LINK_MAX_TXS` | `500` | Max transfer-history txs per winner. |
| `LINK_MAX_TARGETS` | `50` | Max funded targets recorded per winner. |
| `LINK_TIME_BUDGET_MS` | `50000` | Per-run time budget for link tracking. |
| `LINK_DENY` | — | Extra recipient addresses to ignore (e.g. CEX hot wallets), comma/space-separated. |

### GMGN cheap-screen tier

| Var | Default | Purpose |
|-----|---------|---------|
| `SCREEN_MIN_PROFIT_USD` | `0` | `screen_pass` needs realized profit above this. |
| `SCREEN_MIN_TOKENS` | `5` | …and at least this many distinct tokens. |

(GMGN workflow secrets/vars: `GMGN_API_KEY`, `TRANSPORT_URL`, plus `CRON_SECRET`.)

### Alerts

| Var | Default | Purpose |
|-----|---------|---------|
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token (with `TELEGRAM_CHAT_ID` enables Telegram alerts). |
| `TELEGRAM_CHAT_ID` | — | Telegram chat to post into. |
| `ALERT_WEBHOOK_URL` | — | Generic webhook, POSTed `{ text }`. |

Alerts are capped per run (`ALERT_CAP = 25` in `lib/alerts/detect.ts`).

---

## 7. Operating it

### Bootstrap
1. **Run the migration** — paste the consolidated SQL (section 5) into the
   Supabase SQL editor. Verify with `GET /api/status` →
   `migrationApplied: true`. If false, `roi_pct`/`verified` columns are missing
   and nothing can be marked verified/smart.
2. **Set env** — `HELIUS_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY` (and `CRON_SECRET` if you want the cron/ingest
   endpoints locked).
3. **Prime the pool** — trigger `GET /api/cron/graduations` (full-captures
   busy graduated coins → enqueues thousands of candidate wallets).
4. **Verify** — trigger `GET /api/cron/seed-wallets` to deep-scan the backlog
   into accurate ROI (`verified=true`). Repeat / let the hourly cron drain it.
5. Confirm via `GET /api/status` (watch `verifiedWallets` and `smartWallets`
   climb) and `GET /api/smart-money/list`.

> Manually-trusted wallets: set `SEED_WALLETS` (or use the committed seed list)
> and they take priority in `run-seed-indexer`, get flagged `seeded`, and always
> clear the curation gate. With no seeds configured the worker auto-refines its
> own top-discovered candidates instead.

### Tuning conviction (no redeploy needed)
- Raise **`SMART_MIN_ROI_PCT`** (e.g. 50, 100) to demand bigger all-time
  winners.
- Raise **`SMART_MIN_INVESTED_SOL`** to require ROI measured on real capital —
  this filters lucky tiny-sample wallets.
- Raise `SMART_MIN_PNL_SOL` / `SMART_MIN_TRADES` / `SMART_MIN_TOKENS` for more
  evidence; lower `SMART_MAX_IDLE_DAYS` for only recently-active traders.
- Inspect raw numbers with `GET /api/smart-money/list?gate=0` to calibrate
  thresholds before tightening them. "Smart" is recomputed on read, so changes
  take effect immediately.

### Throttling Helius cost
- Lower `SEED_MAX_WALLETS` / `SEED_MAX_TXS` (deep scan is the biggest cost).
- Lower `GRAD_MAX_COINS` / `GRAD_MAX_TXS`, `CHAIN_*`, `INDEX_*`, `LINK_*`.
- Raise `GRAD_MIN_TXNS24H` and `SCAN_MIN_TRADES` to skip thin coins / noise
  wallets. Each runner is also wrapped in a `*_TIME_BUDGET_MS` so a run never
  overruns the serverless limit.

### GMGN cheap-screen path
To avoid spending Helius credits verifying every captured wallet:
1. Run `gmgn-cli` somewhere Vercel can't (a VPS / GitHub runner). Fill in the
   "Install gmgn-cli" step in `.github/workflows/gmgn-screen.yml` and set
   `GMGN_API_KEY`, `TRANSPORT_URL` (+ `CRON_SECRET`).
2. The job pulls `GET /api/ingest/wallet-stats?limit=200` (wallets needing a
   screen), fetches GMGN's precomputed PnL, then
   `POST /api/ingest/wallet-stats` with the results.
3. Wallets passing the lenient screen (`SCREEN_MIN_PROFIT_USD` /
   `SCREEN_MIN_TOKENS`) get `screen_pass=true` and jump to the front of the
   deep-scan backlog — so Helius only verifies likely winners.

---

## 8. Accuracy notes

The single source of truth for the headline number is
`lib/indexer/accurate-pnl.ts` (`computeAccuratePnL`).

- **Realized FIFO cost basis.** Per token, trades are replayed in chronological
  order (stable on equal timestamps). A SELL consumes the oldest BUY lots first.
- **ROI denominator.** `roiPct = realizedPnl ÷ matchedCost × 100`, where
  `matchedCost` (`invested_sol`) is the cost basis of the **quantity actually
  sold** — not all capital ever deployed. This is the "up X% all-time" figure.
- **Partial fills / unmatched sells.** A sell larger than the held lots realizes
  what it can; the excess (a sell whose buy predates our captured history) is
  set aside as `unmatchedSoldSol` and counted as **neither profit nor cost** —
  it never inflates ROI.
- **Open exposure** (tokens still held) is tracked as `remainingCostSol` and
  excluded from realized PnL/ROI.
- **Fees.** Inputs are SOL-quoted `Trade` objects already fee-adjusted by the
  swap parser, so fees are baked into prices before the FIFO replay.
- **Win rate is not a floor.** `winRate` is winning realized events ÷ (winning +
  losing), break-even excluded. The curation gate deliberately does **not**
  require a high win rate (`SMART_MAX_WIN_RATE` defaults to off): the best
  snipers win well under half their trades but win big. A win-rate floor would
  wrongly exclude these asymmetric winners; an implausibly-high win rate at scale
  is instead treated as a **bot signal**.
- **Bot/MEV/arb exclusion** (`bot-filter.ts`, conservative by design): flags
  hyperactive churn (≥500 trades & ≥30 trades/token), dust-size clips
  (<0.01 SOL avg), near-zero-edge high volume (≥1000 trades & |ROI|<1%), and
  implausible win rate at scale (≥0.97 over ≥200 trades). Any one trigger
  excludes the wallet unless `SMART_ALLOW_BOTS=1`.
- **Test suite.** 50+ cases across 11 Jest files
  (`lib/__tests__/` + `app/api/__tests__/`) cover the FIFO engine
  (`accurate-pnl.test.ts`), curation gate, bot filter, wallet tags, clustering,
  swap parsing, and the leaderboard API — including partial-fill, unmatched-sell,
  and break-even edge cases.
