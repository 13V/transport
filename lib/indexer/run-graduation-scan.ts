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
import {
  getGraduatedCoins,
  getAgedWinnerCoins,
  resolvePairAddress,
  fullScanCoin,
  type GraduatedCoin,
} from './graduations';
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
  shard?: number; // this job's shard index (0..shards-1)
  shards?: number; // total parallel jobs; >1 partitions the todo list
}

/** Stable shard for a mint so parallel scans cover disjoint coins. */
function hashMint(mint: string): number {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (Math.imul(31, h) + mint.charCodeAt(i)) | 0;
  return h >>> 0;
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

  // Candidate pool comes from TWO sources, merged & deduped by mint:
  //   1. getGraduatedCoins()  — fresh/active graduations (ranked by 24h txns).
  //   2. getAgedWinnerCoins() — AGED winners that ran up to ~100k+ market cap.
  //      Their value is the historical trader base, so they do NOT require any
  //      current 24h activity — this is the bulk "Wallets indexed" lever.
  // Aged sourcing is on by default; gate it off with GRAD_INCLUDE_AGED=0.
  // Env knobs: AGED_MIN_MC_USD (min market cap, default 100000),
  //            AGED_MAX_COINS (max aged candidates pulled, default 400).
  const includeAged = process.env.GRAD_INCLUDE_AGED !== '0';
  const [fresh, aged] = await Promise.all([
    getGraduatedCoins(Math.max(80, maxCoins * 3)),
    includeAged ? getAgedWinnerCoins() : Promise.resolve<GraduatedCoin[]>([]),
  ]);

  // Order: fresh active coins first (highest txns24h), then aged winners by
  // marketCapUsd desc. The <24h rescan skip below guarantees we ADVANCE through
  // new coins on each run rather than re-scanning the same head of the list.
  const freshSorted = [...fresh].sort((a, b) => (b.txns24h ?? 0) - (a.txns24h ?? 0));
  const agedSorted = [...aged].sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));

  const candidates: GraduatedCoin[] = [];
  const seen = new Set<string>();
  for (const c of [...freshSorted, ...agedSorted]) {
    if (!c.mint || seen.has(c.mint)) continue;
    seen.add(c.mint);
    candidates.push(c);
  }

  if (candidates.length === 0) {
    return { ...blank(start), ok: true, error: 'No graduated/aged coins returned by sources' };
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

  let todo = candidates.filter((c) => !recentlyScanned.has(c.mint));

  // SHARDING: when multiple parallel jobs run, each keeps only the coins whose
  // stable mint-hash maps to its shard, so the N jobs scan DISJOINT coins and
  // never double-scan. Applied AFTER dedupe + recently-scanned skip and BEFORE
  // the maxCoins/time-budget scan loop. Single-job (shards<=1) is a no-op.
  const shards = opts.shards ?? 1;
  const shard = opts.shard ?? 0;
  if (shards > 1) {
    todo = todo.filter((c) => hashMint(c.mint) % shards === shard);
  }

  let coinsScanned = 0;
  let tradesIngested = 0;
  let walletsCaptured = 0;
  const detail: Array<Record<string, unknown>> = [];

  for (const coin of todo) {
    if (coinsScanned >= maxCoins) break;
    if (Date.now() - start > timeBudgetMs) break;

    try {
      // fullScanCoin needs the AMM pool address. Fresh coins carry it; aged
      // winners may not, so resolve it here (within the time budget). If it
      // can't be resolved, skip the coin rather than wasting a scan slot.
      let pairAddress = coin.pairAddress;
      if (!pairAddress) {
        pairAddress = await resolvePairAddress(coin.mint);
        if (!pairAddress) {
          detail.push({ mint: coin.mint, symbol: coin.symbol, skipped: 'no_pair' });
          continue;
        }
      }

      const res = await fullScanCoin(supabase, coin.mint, coin.symbol, maxTxsPerCoin, pairAddress);
      coinsScanned += 1;
      tradesIngested += res.trades;
      walletsCaptured += res.wallets;
      detail.push({
        mint: coin.mint,
        symbol: coin.symbol,
        pair: pairAddress ?? null,
        txns24h: coin.txns24h ?? null,
        volumeUsd24h: coin.volumeUsd24h ?? null,
        marketCapUsd: coin.marketCapUsd ?? null,
        trades: res.trades,
        wallets: res.wallets,
      });
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
