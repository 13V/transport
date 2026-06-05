/**
 * GRADUATION SCAN ORCHESTRATOR
 *
 * Finds graduated pump.fun -> PumpSwap coins and fully ingests the ones we
 * haven't captured yet — pulling every swap and enqueuing every wallet for
 * deep-scan analysis. This is the front of the funnel: it's what grows the
 * wallet pool into the thousands. The deep-scan worker (run-seed-indexer) then
 * drains that backlog into accurate, verified scores over successive runs.
 *
 * Bounded per run (full history is many Helius pages per coin); coins already
 * fully scanned are skipped, so successive runs work through new graduations.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getGraduatedCoins, fullScanCoin } from './graduations';
import { envInt } from './env';

export interface GraduationScanResult {
  ok: boolean;
  coinsConsidered: number;
  coinsScanned: number;
  tradesIngested: number;
  walletsCaptured: number;
  elapsedMs: number;
  error?: string;
  debug?: Record<string, unknown>;
}

export interface GraduationScanOptions {
  maxCoins?: number; // graduated coins to fully scan this run
  maxTxsPerCoin?: number; // depth of full history per coin
  rescanAfterHours?: number; // re-ingest a coin only if older than this
  timeBudgetMs?: number;
}

export async function runGraduationScan(
  opts: GraduationScanOptions = {}
): Promise<GraduationScanResult> {
  const start = Date.now();
  const maxCoins = opts.maxCoins ?? envInt('GRAD_MAX_COINS', 3);
  const maxTxsPerCoin = opts.maxTxsPerCoin ?? envInt('GRAD_MAX_TXS', 3000);
  const rescanAfterHours = opts.rescanAfterHours ?? 24;
  const timeBudgetMs = opts.timeBudgetMs ?? envInt('GRAD_TIME_BUDGET_MS', 50_000);

  if (!isSupabaseConfigured()) {
    return blank(start, 'Supabase not configured');
  }
  if (!process.env.HELIUS_API_KEY) {
    return blank(start, 'HELIUS_API_KEY missing — cannot fetch swaps');
  }

  const supabase = getSupabase();
  const candidates = await getGraduatedCoins(40);
  if (candidates.length === 0) {
    return { ...blank(start), ok: true, error: 'No graduated coins returned by DexScreener' };
  }

  // Skip coins already fully scanned recently.
  const { data: known } = await supabase
    .from('coins')
    .select('mint, full_scanned_at')
    .in('mint', candidates.map((c) => c.mint));
  const cutoff = Date.now() - rescanAfterHours * 3_600_000;
  const recentlyScanned = new Set(
    (known ?? [])
      .filter((r: any) => r.full_scanned_at && new Date(r.full_scanned_at).getTime() > cutoff)
      .map((r: any) => r.mint)
  );

  const todo = candidates.filter((c) => !recentlyScanned.has(c.mint));

  let coinsScanned = 0;
  let tradesIngested = 0;
  let walletsCaptured = 0;
  const detail: Array<Record<string, unknown>> = [];

  for (const coin of todo) {
    if (coinsScanned >= maxCoins) break;
    if (Date.now() - start > timeBudgetMs) break;

    try {
      const res = await fullScanCoin(supabase, coin.mint, coin.symbol, maxTxsPerCoin);
      coinsScanned += 1;
      tradesIngested += res.trades;
      walletsCaptured += res.wallets;
      detail.push({ mint: coin.mint, symbol: coin.symbol, trades: res.trades, wallets: res.wallets });
    } catch (err) {
      console.error(`[GRAD] full scan failed for ${coin.mint}:`, (err as Error).message);
    }
  }

  await supabase.from('indexer_state').upsert(
    {
      key: 'last_graduation_scan',
      value: { at: new Date().toISOString(), coinsScanned, tradesIngested, walletsCaptured },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );

  return {
    ok: true,
    coinsConsidered: candidates.length,
    coinsScanned,
    tradesIngested,
    walletsCaptured,
    elapsedMs: Date.now() - start,
    debug: { newGraduations: todo.length, detail },
  };
}

function blank(start: number, error?: string): GraduationScanResult {
  return {
    ok: !error,
    coinsConsidered: 0,
    coinsScanned: 0,
    tradesIngested: 0,
    walletsCaptured: 0,
    elapsedMs: Date.now() - start,
    error,
  };
}
