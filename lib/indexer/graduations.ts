/**
 * GRADUATION CAPTURE
 *
 * When a pump.fun coin graduates to PumpSwap it has a real, completed trader
 * base. This module finds graduated coins and ingests their ENTIRE swap history
 * — every wallet that ever bought or sold — so they all become candidates for
 * accurate deep-scan analysis. This is how the wallet pool scales into the
 * thousands rather than the dozens a windowed scan yields.
 *
 *   getGraduatedCoins() — recently-active PumpSwap (graduated) coins (DexScreener)
 *   fullScanCoin()      — pull a coin's full history, persist every trade, and
 *                         enqueue every wallet (stub wallet_stats rows) for the
 *                         deep-scan worker to verify.
 */

import axios from 'axios';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllWalletTradesForToken } from './swap-fetcher';
import { getPumpFunCoins } from './pumpfun-coins';

const DEXSCREENER_SEARCH = 'https://api.dexscreener.com/latest/dex/search';
const DEXSCREENER_BOOSTS = [
  'https://api.dexscreener.com/token-boosts/top/v1',
  'https://api.dexscreener.com/token-boosts/latest/v1',
];

// Stablecoins / wrapped SOL — never full-scan these.
const EXCLUDED = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'So11111111111111111111111111111111111111112',
]);

const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens';

export interface GraduatedCoin {
  mint: string;
  symbol?: string;
  pairAddress?: string; // AMM pool — scan THIS for every swap, not the mint
  txns24h?: number;
  volumeUsd24h?: number;
  marketCapUsd?: number;
}

/** Collect a broad pool of candidate Solana mints from boosts + search. */
async function getCandidateMints(): Promise<string[]> {
  const seen = new Set<string>();
  const add = (mint?: string) => {
    if (mint && !seen.has(mint) && !EXCLUDED.has(mint)) seen.add(mint);
  };

  for (const url of DEXSCREENER_BOOSTS) {
    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      for (const it of Array.isArray(data) ? data : []) {
        if (it?.chainId === 'solana') add(it?.tokenAddress);
      }
    } catch (err) {
      console.error('[GRAD] boosts fetch failed:', (err as Error).message);
    }
  }
  try {
    const { data } = await axios.get(DEXSCREENER_SEARCH, { params: { q: 'pumpswap' }, timeout: 10000 });
    for (const p of Array.isArray(data?.pairs) ? data.pairs : []) {
      if (p?.chainId === 'solana') add(p?.baseToken?.address);
    }
  } catch {
    /* optional */
  }
  return [...seen];
}

/**
 * Active Solana coins with REAL trader bases, ranked by 24h trade count.
 *
 * Boosted lists alone surface tiny freshly-promoted coins (8-50 trades), which
 * yield almost no wallets. So we pull a broad candidate pool, look up each
 * coin's 24h activity via DexScreener's batched token endpoint, and return the
 * busiest ones — those have the thousands of wallets worth ingesting.
 */
export async function getGraduatedCoins(limit = 12): Promise<GraduatedCoin[]> {
  const minTxns = Number(process.env.GRAD_MIN_TXNS24H ?? 300);
  const candidates = await getCandidateMints();
  if (candidates.length === 0) return [];

  const ranked = new Map<string, GraduatedCoin>();
  for (let i = 0; i < candidates.length; i += 30) {
    const chunk = candidates.slice(i, i + 30);
    try {
      const { data } = await axios.get(`${DEXSCREENER_TOKENS}/${chunk.join(',')}`, { timeout: 12000 });
      for (const p of Array.isArray(data?.pairs) ? data.pairs : []) {
        if (p?.chainId !== 'solana') continue;
        const mint: string | undefined = p?.baseToken?.address;
        if (!mint || EXCLUDED.has(mint)) continue;
        const txns = Number(p?.txns?.h24?.buys ?? 0) + Number(p?.txns?.h24?.sells ?? 0);
        const vol = Number(p?.volume?.h24 ?? 0);
        const mc = Number(p?.marketCap ?? p?.fdv);
        const prev = ranked.get(mint);
        // Keep the most-active pair per token (its pool has the most swaps).
        if (!prev || txns > (prev.txns24h ?? 0)) {
          ranked.set(mint, {
            mint,
            symbol: p?.baseToken?.symbol,
            pairAddress: p?.pairAddress,
            txns24h: txns,
            volumeUsd24h: vol,
            marketCapUsd: Number.isNaN(mc) ? undefined : mc,
          });
        }
      }
    } catch (err) {
      console.error('[GRAD] token activity lookup failed:', (err as Error).message);
    }
  }

  // If the activity lookup failed entirely, fall back to raw candidates.
  if (ranked.size === 0) return candidates.slice(0, limit).map((mint) => ({ mint }));

  return [...ranked.values()]
    .filter((c) => (c.txns24h ?? 0) >= minTxns)
    .sort((a, b) => (b.txns24h ?? 0) - (a.txns24h ?? 0))
    .slice(0, limit);
}

/**
 * AGED WINNER COINS — bulk wallet-sourcing lever.
 *
 * Fresh-graduation sourcing (getGraduatedCoins) is gated on CURRENT 24h activity,
 * which limits the candidate pool to whatever is hot right now. Aged winners are
 * coins that already ran up to a meaningful market cap (~100k+) at some point;
 * their value is the HISTORICAL trader base, so we intentionally do NOT require
 * any current 24h activity. fullScanCoin will stub-row every wallet that ever
 * traded them, which is the real "Wallets indexed" lever.
 *
 * Sourced from the pump.fun coin list (./pumpfun-coins). Resilient: returns []
 * on any failure so the scan falls back to fresh graduations only.
 */
// Sort keys we rotate through so successive runs surface DIFFERENT aged winners.
// pump.fun's API supports these sort fields; combined with the order flip below
// each hour bucket sees a distinct slice of the historical coin pool.
const AGED_SORTS = ['market_cap', 'last_trade_timestamp', 'created_timestamp'] as const;

export async function getAgedWinnerCoins(opts?: {
  minMcUsd?: number;
  maxCoins?: number;
}): Promise<GraduatedCoin[]> {
  try {
    // ROTATION: the top-N-by-MC pool is static, so after one pass it yields
    // nothing new for 24h. Derive a rotating seed from the current hour bucket
    // and vary sort + order each call so we keep surfacing fresh aged winners
    // rather than re-scanning the same MC-desc head every run.
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    const sort = AGED_SORTS[hourBucket % AGED_SORTS.length];
    // Flip order on alternating buckets to reach the opposite end of each sort
    // (e.g. lowest-qualifying MC, oldest creations) — more distinct coverage.
    const order: 'ASC' | 'DESC' = hourBucket % 2 === 0 ? 'DESC' : 'ASC';

    const coins = await getPumpFunCoins({
      minMcUsd: opts?.minMcUsd ?? Number(process.env.AGED_MIN_MC_USD ?? 100000),
      maxCoins: opts?.maxCoins ?? Number(process.env.AGED_MAX_COINS ?? 600),
      sort,
      order,
    });
    return (coins ?? [])
      .filter((c) => c?.mint && !EXCLUDED.has(c.mint))
      .map((c) => ({
        mint: c.mint,
        symbol: c.symbol,
        pairAddress: c.pairAddress,
        marketCapUsd: c.marketCapUsd,
      }));
  } catch (err) {
    console.error('[GRAD] aged winner source failed:', (err as Error).message);
    return [];
  }
}

/** Resolve a mint's busiest Solana pool address (where the swaps live). */
export async function resolvePairAddress(mint: string): Promise<string | undefined> {
  try {
    const { data } = await axios.get(`${DEXSCREENER_TOKENS}/${mint}`, { timeout: 10000 });
    let best: string | undefined;
    let bestTxns = -1;
    for (const p of Array.isArray(data?.pairs) ? data.pairs : []) {
      if (p?.chainId !== 'solana' || !p?.pairAddress) continue;
      const txns = Number(p?.txns?.h24?.buys ?? 0) + Number(p?.txns?.h24?.sells ?? 0);
      if (txns > bestTxns) {
        bestTxns = txns;
        best = p.pairAddress;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

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

export interface FullScanResult {
  mint: string;
  trades: number;
  wallets: number;
  skipped?: boolean;
}

/**
 * Ingest a coin's full swap history: persist every trade and enqueue every
 * wallet (a stub wallet_stats row, verified=false) for later deep-scan. Stub
 * upserts ignore duplicates so already-verified wallets are never downgraded.
 */
export async function fullScanCoin(
  supabase: SupabaseClient,
  mint: string,
  symbol: string | undefined,
  maxTxs: number,
  scanAddress?: string
): Promise<FullScanResult> {
  // Scan the AMM pool — that's where every swap lives. Resolve it if not given.
  const pool = scanAddress || (await resolvePairAddress(mint));
  const walletTrades = await fetchAllWalletTradesForToken(mint, maxTxs, pool);

  if (walletTrades.length === 0) {
    await supabase.from('coins').upsert(
      { mint, symbol, graduated: true, full_scanned_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: 'mint' }
    );
    return { mint, trades: 0, wallets: 0 };
  }

  const tradeRows = walletTrades.map(({ wallet, trade }) => ({
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
  const tradeErr = await upsertInChunks(supabase, 'trades', tradeRows, {
    onConflict: 'tx_hash,wallet,token_mint,trade_type',
    ignoreDuplicates: true,
  });
  if (tradeErr) console.error(`[GRAD] trade upsert failed for ${mint}:`, tradeErr);

  // Enqueue every wallet as a candidate (stub row; ignore if it already exists).
  const wallets = [...new Set(walletTrades.map((w) => w.wallet))];
  const stubErr = await upsertInChunks(
    supabase,
    'wallet_stats',
    wallets.map((wallet) => ({ wallet })),
    { onConflict: 'wallet', ignoreDuplicates: true }
  );
  if (stubErr) console.error(`[GRAD] wallet enqueue failed for ${mint}:`, stubErr);

  await supabase.from('coins').upsert(
    {
      mint,
      symbol,
      graduated: true,
      full_scanned_at: new Date().toISOString(),
      trades_found: tradeRows.length,
      wallets_found: wallets.length,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'mint' }
  );

  return { mint, trades: tradeRows.length, wallets: wallets.length };
}
