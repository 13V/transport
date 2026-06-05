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
import { aggregateWallet } from './aggregator';
import type { Trade } from '../pnl-engine';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SeedIndexerResult {
  ok: boolean;
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
 * Upsert a wallet's stats with the seeded flag. Falls back to an upsert without
 * the seed columns if they don't exist yet (i.e. the schema migration hasn't
 * been applied), so a half-migrated DB degrades instead of erroring out.
 */
async function upsertSeededStat(
  supabase: SupabaseClient,
  row: Record<string, unknown>
): Promise<{ error: { message: string } | null; degraded: boolean }> {
  const { error } = await supabase.from('wallet_stats').upsert(row, { onConflict: 'wallet' });
  if (!error) return { error: null, degraded: false };

  // Missing column → retry without the seed fields rather than dropping the wallet.
  const msg = error.message?.toLowerCase() ?? '';
  if (msg.includes('seeded') || msg.includes('seed_source') || msg.includes('column')) {
    const { seeded, seed_source, ...base } = row;
    void seeded;
    void seed_source;
    const { error: baseErr } = await supabase
      .from('wallet_stats')
      .upsert(base, { onConflict: 'wallet' });
    return { error: baseErr, degraded: !baseErr };
  }
  return { error, degraded: false };
}

export async function runSeedIndexer(opts: SeedIndexerOptions = {}): Promise<SeedIndexerResult> {
  const start = Date.now();
  const maxWallets = opts.maxWallets ?? 30;
  const maxTxsPerWallet = opts.maxTxsPerWallet ?? 500;
  const timeBudgetMs = opts.timeBudgetMs ?? 50_000;

  const base = {
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

  const seedWallets = getSeedWallets();
  if (seedWallets.length === 0) {
    return {
      ok: true,
      ...base,
      elapsedMs: Date.now() - start,
      error:
        'No seed wallets configured — add addresses to lib/indexer/seed-wallet-list.ts or set SEED_WALLETS',
    };
  }

  const supabase = getSupabase();
  const wallets = seedWallets.slice(0, maxWallets);

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

    const stat = aggregateWallet(wallet, trades);

    const { error: upErr, degraded } = await upsertSeededStat(supabase, {
      wallet: stat.wallet,
      score: stat.score,
      realized_pnl: stat.realizedPnl,
      win_rate: stat.winRate,
      consistency: stat.consistency,
      total_trades: stat.totalTrades,
      tokens_traded: stat.tokensTraded,
      last_trade_at: stat.lastTradeAt ? stat.lastTradeAt.toISOString() : null,
      seeded: true,
      seed_source: SEED_SOURCE,
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
        seedWallets: seedWallets.length,
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
    seedWallets: seedWallets.length,
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
