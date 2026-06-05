/**
 * INDEXER ORCHESTRATOR
 *
 * One run:
 *   1. Pick a set of active tokens (DexScreener)
 *   2. Pull real swaps per token (Helius) → wallet-attributed trades
 *   3. Upsert trades into Supabase (dedup via unique constraint)
 *   4. Recompute wallet_stats for every wallet touched this run
 *
 * Designed to run repeatedly (Vercel Cron). Each run is bounded so it fits in
 * the serverless time budget; the leaderboard fills out over successive runs.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getTokenUniverse } from './token-universe';
import { fetchWalletTradesForToken } from './swap-fetcher';
import { aggregateWallet } from './aggregator';
import type { Trade } from '../pnl-engine';

export interface IndexerResult {
  ok: boolean;
  tokensScanned: number;
  tradesIngested: number;
  walletsUpdated: number;
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

export async function runIndexer(opts: IndexerOptions = {}): Promise<IndexerResult> {
  const start = Date.now();
  const maxTokens = opts.maxTokens ?? 15;
  const swapsPerToken = opts.swapsPerToken ?? 100;
  const timeBudgetMs = opts.timeBudgetMs ?? 50_000;

  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      tokensScanned: 0,
      tradesIngested: 0,
      walletsUpdated: 0,
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
      walletsUpdated: 0,
      elapsedMs: Date.now() - start,
      error: 'HELIUS_API_KEY missing — cannot fetch real swaps',
      debug: envReport(),
    };
  }

  const supabase = getSupabase();
  const tokens = await getTokenUniverse(maxTokens);
  const touchedWallets = new Set<string>();
  let tradesIngested = 0;
  let tokensScanned = 0;

  for (const token of tokens) {
    if (Date.now() - start > timeBudgetMs * 0.7) break;
    tokensScanned += 1;

    const walletTrades = await fetchWalletTradesForToken(token.mint, swapsPerToken);
    if (walletTrades.length === 0) continue;

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

    const { error } = await supabase
      .from('trades')
      .upsert(rows, {
        onConflict: 'tx_hash,wallet,token_mint,trade_type',
        ignoreDuplicates: true,
      });

    if (error) {
      console.error(`[INDEXER] upsert trades failed for ${token.mint}:`, error.message);
      continue;
    }

    tradesIngested += rows.length;
    for (const { wallet } of walletTrades) touchedWallets.add(wallet);
  }

  // Recompute stats for each touched wallet from its FULL trade history in DB.
  let walletsUpdated = 0;
  for (const wallet of touchedWallets) {
    if (Date.now() - start > timeBudgetMs) break;

    const { data, error } = await supabase
      .from('trades')
      .select('token_mint, trade_type, amount, price, source, tx_hash, block_time')
      .eq('wallet', wallet)
      .order('block_time', { ascending: true })
      .limit(2000);

    if (error || !data) {
      console.error(`[INDEXER] read trades failed for ${wallet}:`, error?.message);
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

    const stat = aggregateWallet(wallet, trades);

    const { error: upErr } = await supabase.from('wallet_stats').upsert(
      {
        wallet: stat.wallet,
        score: stat.score,
        realized_pnl: stat.realizedPnl,
        win_rate: stat.winRate,
        consistency: stat.consistency,
        total_trades: stat.totalTrades,
        tokens_traded: stat.tokensTraded,
        last_trade_at: stat.lastTradeAt ? stat.lastTradeAt.toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'wallet' }
    );

    if (upErr) {
      console.error(`[INDEXER] upsert wallet_stats failed for ${wallet}:`, upErr.message);
      continue;
    }
    walletsUpdated += 1;
  }

  // Bookkeeping
  await supabase.from('indexer_state').upsert(
    {
      key: 'last_run',
      value: {
        at: new Date().toISOString(),
        tokensScanned,
        tradesIngested,
        walletsUpdated,
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );

  return {
    ok: true,
    tokensScanned,
    tradesIngested,
    walletsUpdated,
    elapsedMs: Date.now() - start,
  };
}
