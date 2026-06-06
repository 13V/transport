/**
 * INDEXER ORCHESTRATOR
 *
 * One run:
 *   1. Pick a set of active tokens (DexScreener)
 *   2. Pull real swaps per token (Helius) → wallet-attributed trades
 *   3. Batch-upsert trades into Supabase (dedup via unique constraint)
 *   4. STUB-ROW every distinct trader into wallet_stats (ignoreDuplicates) so new
 *      unverified wallets are ADDED — never overwriting existing/verified rows.
 *
 * This run is INGEST-ONLY: it does NOT recompute wallet_stats. The deep-scan
 * drain (run-seed-indexer) computes accurate verified stats later. Keeping this
 * path ingest-only lets it spend the full time budget pulling trades + adding
 * new wallets, which is the real "Wallets indexed" lever.
 *
 * Designed to run repeatedly (Vercel Cron). Each run is bounded so it fits in
 * the serverless time budget; the leaderboard fills out over successive runs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getTokenUniverse } from './token-universe';
import { fetchWalletTradesForToken } from './swap-fetcher';
import { envInt } from './env';

export interface IndexerResult {
  ok: boolean;
  tokensScanned: number;
  tradesIngested: number;
  walletsCaptured: number;
  elapsedMs: number;
  error?: string;
  debug?: Record<string, unknown>;
}

export interface IndexerOptions {
  maxTokens?: number;
  swapsPerToken?: number;
  timeBudgetMs?: number;
}

/** Snapshot of which relevant env vars the runtime actually sees (no secrets). */
function envReport(): Record<string, unknown> {
  const names = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'HELIUS_API_KEY',
  ];
  const report: Record<string, unknown> = {};
  for (const n of names) {
    const v = process.env[n];
    report[n] = { present: Boolean(v), length: (v ?? '').length };
  }
  // Surface any close-but-wrong names that got set by mistake.
  report.relatedKeys = Object.keys(process.env).filter(
    (k) => k.includes('HELIUS') || k.includes('SUPABASE')
  );
  return report;
}

/** Batched upsert mirroring graduations.upsertInChunks — resilient, never throws. */
async function upsertInChunks(
  supabase: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  options: { onConflict: string; ignoreDuplicates?: boolean }
): Promise<string | null> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from(table)
      .upsert(rows.slice(i, i + CHUNK), options);
    if (error) return error.message;
  }
  return null;
}

export async function runIndexer(opts: IndexerOptions = {}): Promise<IndexerResult> {
  const start = Date.now();
  const maxTokens = opts.maxTokens ?? envInt('INDEX_MAX_TOKENS', 15);
  const swapsPerToken = opts.swapsPerToken ?? envInt('INDEX_SWAPS_PER_TOKEN', 100);
  const timeBudgetMs = opts.timeBudgetMs ?? envInt('INDEX_TIME_BUDGET_MS', 50_000);

  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      tokensScanned: 0,
      tradesIngested: 0,
      walletsCaptured: 0,
      elapsedMs: Date.now() - start,
      error: 'Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)',
      debug: envReport(),
    };
  }
  if (!process.env.HELIUS_API_KEY) {
    return {
      ok: false,
      tokensScanned: 0,
      tradesIngested: 0,
      walletsCaptured: 0,
      elapsedMs: Date.now() - start,
      error: 'HELIUS_API_KEY missing — cannot fetch real swaps',
      debug: envReport(),
    };
  }

  const supabase = getSupabase();
  const tokens = await getTokenUniverse(maxTokens);
  const capturedWallets = new Set<string>();
  let tradesIngested = 0;
  let tokensScanned = 0;
  const bySource: Record<string, number> = {};

  for (const token of tokens) {
    // INGEST-ONLY: use the FULL time budget for scanning + ingesting trades.
    if (Date.now() - start > timeBudgetMs) break;
    tokensScanned += 1;

    // A failing token must not abort the whole run.
    try {
      const walletTrades = await fetchWalletTradesForToken(token.mint, swapsPerToken);
      if (walletTrades.length === 0) continue;

      for (const { trade } of walletTrades) {
        bySource[trade.source] = (bySource[trade.source] ?? 0) + 1;
      }

      const rows = walletTrades.map(({ wallet, trade }) => ({
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

      // Batch-upsert all trades (dedup via unique constraint).
      const tradeErr = await upsertInChunks(supabase, 'trades', rows, {
        onConflict: 'tx_hash,wallet,token_mint,trade_type',
        ignoreDuplicates: true,
      });
      if (tradeErr) {
        console.error(`[INDEXER] upsert trades failed for ${token.mint}:`, tradeErr);
        continue;
      }
      tradesIngested += rows.length;

      // STUB-ROW every distinct trader into wallet_stats. ignoreDuplicates means
      // we only ADD new unverified wallets and NEVER downgrade existing/verified
      // rows. The deep-scan drain computes accurate verified stats later.
      const wallets = [...new Set(walletTrades.map((w) => w.wallet))];
      const stubErr = await upsertInChunks(
        supabase,
        'wallet_stats',
        wallets.map((wallet) => ({ wallet })),
        { onConflict: 'wallet', ignoreDuplicates: true }
      );
      if (stubErr) {
        console.error(`[INDEXER] wallet stub upsert failed for ${token.mint}:`, stubErr);
        // Trades are already in; still count the wallets we touched.
      }
      for (const wallet of wallets) capturedWallets.add(wallet);
    } catch (err) {
      console.error(`[INDEXER] token scan failed for ${token.mint}:`, (err as Error).message);
      continue;
    }
  }

  const walletsCaptured = capturedWallets.size;

  // Bookkeeping (resilient — never throw out of the cron path).
  try {
    await supabase.from('indexer_state').upsert(
      {
        key: 'last_run',
        value: {
          at: new Date().toISOString(),
          tokensScanned,
          tradesIngested,
          walletsCaptured,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );
  } catch (err) {
    console.error('[INDEXER] indexer_state bookkeeping failed:', (err as Error).message);
  }

  return {
    ok: true,
    tokensScanned,
    tradesIngested,
    walletsCaptured,
    elapsedMs: Date.now() - start,
    debug: { bySource },
  };
}
