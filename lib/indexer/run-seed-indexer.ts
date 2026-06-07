/**
 * SEED-WALLET INDEXER (wallet-first)
 *
 * Complements the token-first run-indexer. Instead of discovering wallets by
 * scanning active tokens, it takes a curated list of known alpha wallets
 * (lib/indexer/seed-wallets.ts) and deep-scans each one's full swap history via
 * Helius, scoring it with the same PnL engine and upserting into wallet_stats —
 * flagged `seeded` so the UI can label it.
 *
 * One run:
 *   1. Load + validate seed wallets (env + committed list)
 *   2. For each wallet (time-budgeted): fetch its swap history (Helius)
 *   3. Upsert those trades into `trades` (dedup via the same unique constraint)
 *   4. Recompute wallet_stats from the wallet's FULL trade history in the DB
 *      (so seed trades and any token-first trades combine), marked seeded=true
 *
 * Designed to run on a cron, like run-indexer. Bounded to fit the serverless
 * time budget; with many seeds the set fills in over successive runs.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getSeedWallets, SEED_SOURCE } from './seed-wallets';
import { fetchWalletSwapHistory } from './wallet-history-fetcher';
import { canSpend, flushHeliusSpend } from './helius-budget';
import { computeAccuratePnL } from './accurate-pnl';
import { envInt } from './env';
import type { Trade } from '../pnl-engine';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SeedIndexerResult {
  ok: boolean;
  mode: 'configured' | 'auto-candidates';
  seedWallets: number;
  walletsProcessed: number;
  tradesIngested: number;
  walletsUpserted: number;
  elapsedMs: number;
  error?: string;
  debug?: Record<string, unknown>;
}

export interface SeedIndexerOptions {
  /** Shard index (0-based) for parallel draining. */
  shard?: number;
  /** Total number of shards. With shards>1, each call scans a disjoint subset. */
  shards?: number;
  maxWallets?: number;
  maxTxsPerWallet?: number;
  timeBudgetMs?: number;
}

/**
 * Drain the analysis backlog: wallets we've captured (e.g. from graduated-coin
 * ingestion) but not yet deep-scanned. These get full-history scored so their
 * ROI is accurate, marked verified, and removed from the backlog. Most-active
 * wallets first. Falls back to top-by-score if the verified column is absent.
 */
/** Stable shard for a wallet so parallel drains scan disjoint subsets. */
function shardOf(wallet: string, shards: number): number {
  let h = 0;
  for (let i = 0; i < wallet.length; i++) h = (Math.imul(31, h) + wallet.charCodeAt(i)) | 0;
  return (h >>> 0) % shards;
}

async function getCandidateWallets(
  supabase: SupabaseClient,
  limit: number,
  shard = 0,
  shards = 1
): Promise<string[]> {
  const floor = Number(process.env.SCAN_MIN_TRADES ?? 0);
  // When sharded, over-fetch a pool and keep only this shard's wallets so N
  // parallel jobs drain disjoint slices of the backlog without re-scanning.
  const sharded = shards > 1;
  // Keep the over-fetch tight: each shard only needs its slice plus a small
  // cushion for the hash filter. A looser pool just makes every shard do more
  // wasted DB work. (A dedicated index is added separately.)
  const pool = sharded ? Math.min(limit * shards + 200, 5000) : limit;
  const pick = (rows: { wallet: string }[]): string[] => {
    let arr = rows.map((r) => r.wallet);
    if (sharded) arr = arr.filter((w) => shardOf(w, shards) === shard);
    return arr.slice(0, limit);
  };

  // Tier 1: wallets the cheap GMGN screen flagged as promising but not yet
  // Helius-verified. Spending the expensive deep-scan here first is the whole
  // point of the screen — verify likely winners, not every captured wallet.
  const promising = await supabase
    .from('wallet_stats')
    .select('wallet, total_trades')
    .eq('verified', false)
    .eq('screen_pass', true)
    .order('total_trades', { ascending: false })
    .limit(pool);
  if (!promising.error && promising.data && promising.data.length > 0) {
    const picked = pick(promising.data as any[]);
    if (picked.length > 0) return picked;
  }

  // Tier 2: general unverified backlog (most-active first).
  const backlog = await supabase
    .from('wallet_stats')
    .select('wallet, total_trades')
    .eq('verified', false)
    .gte('total_trades', floor)
    .order('total_trades', { ascending: false })
    .limit(pool);

  if (!backlog.error && backlog.data && backlog.data.length > 0) {
    const picked = pick(backlog.data as any[]);
    if (picked.length > 0) return picked;
  }

  // Fallback (pre-migration, or backlog empty): top unverified wallets by
  // score. Keep verified=false so a drained backlog returns [] (lets the
  // workflow's walletsProcessed==0 early-stop fire) rather than re-scanning
  // already-verified wallets forever.
  const { data, error } = await supabase
    .from('wallet_stats')
    .select('wallet, total_trades')
    .eq('verified', false)
    .gte('total_trades', 2)
    .order('score', { ascending: false })
    .limit(pool);
  if (error || !data) {
    console.error('[SEED] candidate fetch failed:', error?.message);
    return [];
  }
  return pick(data as any[]);
}

// Columns added by later migrations. If the DB hasn't been migrated yet, an
// upsert including them errors — so on a column error we retry with just the
// base columns rather than dropping the wallet.
const EXTENDED_COLUMNS = [
  'seeded',
  'seed_source',
  'roi_pct',
  'invested_sol',
  'verified',
  'scored_at',
];

async function upsertStat(
  supabase: SupabaseClient,
  row: Record<string, unknown>
): Promise<{ error: { message: string } | null; degraded: boolean }> {
  const { error } = await supabase.from('wallet_stats').upsert(row, { onConflict: 'wallet' });
  if (!error) return { error: null, degraded: false };

  const msg = error.message?.toLowerCase() ?? '';
  if (msg.includes('column') || EXTENDED_COLUMNS.some((c) => msg.includes(c))) {
    const base = { ...row };
    for (const c of EXTENDED_COLUMNS) delete base[c];
    const { error: baseErr } = await supabase
      .from('wallet_stats')
      .upsert(base, { onConflict: 'wallet' });
    return { error: baseErr, degraded: !baseErr };
  }
  return { error, degraded: false };
}

/**
 * Composite ranking score (0..100) from accurate all-time PnL.
 * 40% realized PnL (10 SOL = full) + 30% win rate + 15% consistency
 * + 15% activity (50 trades = full).
 */
function scoreFromAccurate(p: {
  realizedPnlSol: number;
  winRate: number;
  consistency: number;
  totalTrades: number;
}): number {
  const pnl = p.realizedPnlSol <= 0 ? 0 : Math.min(1, p.realizedPnlSol / 10);
  const activity = p.totalTrades <= 0 ? 0 : Math.min(1, p.totalTrades / 50);
  const score = 100 * (0.4 * pnl + 0.3 * p.winRate + 0.15 * p.consistency + 0.15 * activity);
  return Math.round(score * 100) / 100;
}

export async function runSeedIndexer(opts: SeedIndexerOptions = {}): Promise<SeedIndexerResult> {
  const start = Date.now();
  const maxWallets = opts.maxWallets ?? envInt('SEED_MAX_WALLETS', 30);
  const maxTxsPerWallet = opts.maxTxsPerWallet ?? envInt('SEED_MAX_TXS', 250);
  const timeBudgetMs = opts.timeBudgetMs ?? envInt('SEED_TIME_BUDGET_MS', 50_000);

  const base = {
    mode: 'configured' as const,
    seedWallets: 0,
    walletsProcessed: 0,
    tradesIngested: 0,
    walletsUpserted: 0,
  };

  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      ...base,
      elapsedMs: Date.now() - start,
      error: 'Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)',
    };
  }
  if (!process.env.HELIUS_API_KEY) {
    return {
      ok: false,
      ...base,
      elapsedMs: Date.now() - start,
      error: 'HELIUS_API_KEY missing — cannot fetch wallet history',
    };
  }

  const supabase = getSupabase();

  // Source wallets to deep-scan. Manually-configured wallets (SEED_WALLETS / the
  // committed list) take priority and are flagged `seeded`. With none configured
  // we refine our OWN top-discovered wallets instead.
  const configured = getSeedWallets();
  const mode: 'configured' | 'auto-candidates' =
    configured.length > 0 ? 'configured' : 'auto-candidates';
  const markSeeded = mode === 'configured';

  const sourced =
    mode === 'configured'
      ? configured
      : await getCandidateWallets(supabase, maxWallets, opts.shard ?? 0, opts.shards ?? 1);

  if (sourced.length === 0) {
    return {
      ok: true,
      ...base,
      mode,
      elapsedMs: Date.now() - start,
      error:
        'Nothing to scan yet — no SEED_WALLETS configured and no wallets discovered by the token-first indexer',
    };
  }

  const wallets = sourced.slice(0, maxWallets);
  const concurrency = Math.max(1, envInt('SEED_CONCURRENCY', 6));

  let walletsProcessed = 0;
  let tradesIngested = 0;
  let walletsUpserted = 0;
  let degradedUpserts = 0;
  const bySource: Record<string, number> = {};

  // Per-task result so concurrent tasks never mutate shared counters directly —
  // we sum these deterministically after each batch settles (no races).
  interface ScanResult {
    processed: boolean;
    tradesIngested: number;
    upserted: boolean;
    degraded: boolean;
    bySource: Record<string, number>;
  }

  const scanWallet = async (wallet: string): Promise<ScanResult> => {
    const res: ScanResult = {
      processed: true,
      tradesIngested: 0,
      upserted: false,
      degraded: false,
      bySource: {},
    };

    // 1. Pull the wallet's swap history (the I/O-bound Helius call we parallelize).
    const history = await fetchWalletSwapHistory(wallet, maxTxsPerWallet);

    if (history.length > 0) {
      for (const t of history) res.bySource[t.source] = (res.bySource[t.source] ?? 0) + 1;

      const rows = history.map((trade) => ({
        wallet,
        token_mint: trade.tokenMint,
        trade_type: trade.tradeType,
        amount: trade.amount,
        price: trade.pricePerToken,
        sol_amount: trade.amount * trade.pricePerToken,
        source: trade.source,
        tx_hash: trade.txHash,
        block_time: trade.date.toISOString(),
      }));

      const { error } = await supabase
        .from('trades')
        .upsert(rows, { onConflict: 'tx_hash,wallet,token_mint,trade_type', ignoreDuplicates: true });

      if (error) {
        console.error(`[SEED] upsert trades failed for ${wallet}:`, error.message);
      } else {
        res.tradesIngested = rows.length;
      }
    }

    // 2. Score from the already-in-memory history — no write-then-read round
    //    trip. fetchWalletSwapHistory already returns Trade[], and
    //    computeAccuratePnL sorts internally, so fetch order is fine.
    const trades: Trade[] = history;

    if (trades.length === 0) {
      // No scorable trades. Mark TERMINAL so the wallet leaves the
      // verified=false backlog instead of being re-scanned forever. roi_pct
      // null means it still fails the smart gate. Tolerate missing extended
      // columns via the degraded fallback.
      const { error: termErr, degraded } = await upsertStat(supabase, {
        wallet,
        verified: true,
        total_trades: 0,
        roi_pct: null,
        scored_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (termErr) {
        console.error(`[SEED] terminal upsert failed for ${wallet}:`, termErr.message);
      } else {
        res.upserted = true;
        res.degraded = degraded;
      }
      return res;
    }

    // Accurate all-time PnL/ROI from the wallet's full history (this is the
    // trustworthy "up X% all-time" number). These wallets are marked verified.
    const acc = computeAccuratePnL(trades);
    const score = scoreFromAccurate(acc);

    // Only manually-configured wallets get the `seeded` flag (a human vouched
    // for them). Auto-sourced candidates are scored but left to the computed
    // smart-money gate — don't bypass it by marking them seeded.
    const { error: upErr, degraded } = await upsertStat(supabase, {
      wallet,
      score,
      realized_pnl: acc.realizedPnlSol,
      roi_pct: acc.roiPct,
      invested_sol: acc.investedSol,
      win_rate: acc.winRate,
      consistency: acc.consistency,
      total_trades: acc.totalTrades,
      tokens_traded: acc.tokensTraded,
      last_trade_at: acc.lastTradeAt ? acc.lastTradeAt.toISOString() : null,
      verified: true,
      scored_at: new Date().toISOString(),
      ...(markSeeded ? { seeded: true, seed_source: SEED_SOURCE } : {}),
      updated_at: new Date().toISOString(),
    });

    if (upErr) {
      console.error(`[SEED] upsert wallet_stats failed for ${wallet}:`, upErr.message);
      return res;
    }
    res.upserted = true;
    res.degraded = degraded;
    return res;
  };

  // Bounded-concurrency: process SEED_CONCURRENCY wallets per batch via
  // Promise.all, re-checking the time budget BETWEEN batches so we never start
  // a batch past budget (a started Helius call still completes). Counters are
  // summed from settled per-task results, so concurrency can't race them.
  for (let i = 0; i < wallets.length; i += concurrency) {
    if (Date.now() - start > timeBudgetMs * 0.85) break;
    // Hard cost ceiling: bail out of the drain once the daily Helius credit cap
    // is reached. A batch fans out to `concurrency` wallets x ~3 pages each, so
    // check before starting one.
    if (!(await canSpend(100))) {
      console.warn('[BUDGET] Helius daily cap reached, skipping');
      break;
    }
    const batch = wallets.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(scanWallet));

    for (const r of results) {
      if (r.processed) walletsProcessed += 1;
      tradesIngested += r.tradesIngested;
      if (r.upserted) walletsUpserted += 1;
      if (r.degraded) degradedUpserts += 1;
      for (const [src, n] of Object.entries(r.bySource)) {
        bySource[src] = (bySource[src] ?? 0) + n;
      }
    }
  }

  // Persist any pending Helius credit tally promptly at the end of the run.
  await flushHeliusSpend();

  await supabase.from('indexer_state').upsert(
    {
      key: 'last_seed_run',
      value: {
        at: new Date().toISOString(),
        mode,
        seedWallets: wallets.length,
        walletsProcessed,
        tradesIngested,
        walletsUpserted,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );

  return {
    ok: true,
    mode,
    seedWallets: wallets.length,
    walletsProcessed,
    tradesIngested,
    walletsUpserted,
    elapsedMs: Date.now() - start,
    ...(degradedUpserts > 0
      ? {
          error:
            'MIGRATION MISSING: wallet_stats has no roi_pct/verified columns — run supabase/schema.sql. Wallets were saved WITHOUT accurate ROI, so they will not appear as verified/smart.',
        }
      : {}),
    debug: { bySource, degradedUpserts },
  };
}
