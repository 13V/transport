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
import { computeAccuratePnL } from './accurate-pnl';
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
async function getCandidateWallets(supabase: SupabaseClient, limit: number): Promise<string[]> {
  const floor = Number(process.env.SCAN_MIN_TRADES ?? 0);
  const backlog = await supabase
    .from('wallet_stats')
    .select('wallet, total_trades')
    .eq('verified', false)
    .gte('total_trades', floor)
    .order('total_trades', { ascending: false })
    .limit(limit);

  if (!backlog.error && backlog.data && backlog.data.length > 0) {
    return backlog.data.map((r: any) => r.wallet);
  }

  // Fallback (pre-migration, or backlog empty): top wallets by score.
  const { data, error } = await supabase
    .from('wallet_stats')
    .select('wallet, total_trades')
    .gte('total_trades', 2)
    .order('score', { ascending: false })
    .limit(limit);
  if (error || !data) {
    console.error('[SEED] candidate fetch failed:', error?.message);
    return [];
  }
  return data.map((r: any) => r.wallet);
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
  const maxWallets = opts.maxWallets ?? 30;
  const maxTxsPerWallet = opts.maxTxsPerWallet ?? 500;
  const timeBudgetMs = opts.timeBudgetMs ?? 50_000;

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
    mode === 'configured' ? configured : await getCandidateWallets(supabase, maxWallets);

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

  let walletsProcessed = 0;
  let tradesIngested = 0;
  let walletsUpserted = 0;
  let degradedUpserts = 0;
  const bySource: Record<string, number> = {};

  for (const wallet of wallets) {
    if (Date.now() - start > timeBudgetMs * 0.85) break;
    walletsProcessed += 1;

    // 1. Pull the wallet's swap history and persist the trades.
    const history = await fetchWalletSwapHistory(wallet, maxTxsPerWallet);
    if (history.length > 0) {
      for (const t of history) bySource[t.source] = (bySource[t.source] ?? 0) + 1;

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
        tradesIngested += rows.length;
      }
    }

    // 2. Recompute stats from the wallet's FULL history in the DB (seed +
    //    any token-first trades), then upsert flagged as seeded.
    const { data, error: readErr } = await supabase
      .from('trades')
      .select('token_mint, trade_type, amount, price, source, tx_hash, block_time')
      .eq('wallet', wallet)
      .order('block_time', { ascending: true })
      .limit(5000);

    if (readErr || !data) {
      console.error(`[SEED] read trades failed for ${wallet}:`, readErr?.message);
      continue;
    }

    const trades: Trade[] = data.map((r: any) => ({
      tokenMint: r.token_mint,
      tradeType: r.trade_type,
      amount: Number(r.amount),
      pricePerToken: Number(r.price),
      date: new Date(r.block_time),
      txHash: r.tx_hash,
      source: r.source,
    }));

    if (trades.length === 0) continue; // no SOL-quoted swaps to score

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
      continue;
    }
    if (degraded) degradedUpserts += 1;
    walletsUpserted += 1;
  }

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
    debug: {
      bySource,
      ...(degradedUpserts > 0
        ? { warning: `seed columns missing on wallet_stats (${degradedUpserts} wallets upserted without seeded flag) — run the schema migration` }
        : {}),
    },
  };
}
