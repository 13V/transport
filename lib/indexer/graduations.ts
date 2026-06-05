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

export interface GraduatedCoin {
  mint: string;
  symbol?: string;
}

/**
 * Active Solana coins with real trader bases to fully ingest. Primary source is
 * DexScreener's boosted/trending lists (the same reliable source the indexer
 * uses); we also fold in a best-effort PumpSwap search. pump.fun mints first.
 */
export async function getGraduatedCoins(limit = 40): Promise<GraduatedCoin[]> {
  const seen = new Set<string>();
  const out: GraduatedCoin[] = [];

  const add = (mint?: string, symbol?: string) => {
    if (!mint || seen.has(mint) || EXCLUDED.has(mint)) return;
    seen.add(mint);
    out.push({ mint, symbol });
  };

  // 1. Boosted / trending Solana tokens — reliable, returns real active coins.
  for (const url of DEXSCREENER_BOOSTS) {
    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      for (const it of Array.isArray(data) ? data : []) {
        if (it?.chainId !== 'solana') continue;
        add(it?.tokenAddress);
      }
    } catch (err) {
      console.error('[GRAD] boosts fetch failed:', (err as Error).message);
    }
  }

  // 2. Best-effort PumpSwap pairs from search (text match; may add a few).
  try {
    const { data } = await axios.get(DEXSCREENER_SEARCH, { params: { q: 'pumpswap' }, timeout: 10000 });
    for (const p of Array.isArray(data?.pairs) ? data.pairs : []) {
      if (p?.chainId !== 'solana' || p?.dexId !== 'pumpswap') continue;
      add(p?.baseToken?.address, p?.baseToken?.symbol);
    }
  } catch {
    /* search is optional */
  }

  // pump.fun mints first.
  out.sort(
    (a, b) =>
      Number(b.mint.toLowerCase().endsWith('pump')) - Number(a.mint.toLowerCase().endsWith('pump'))
  );
  return out.slice(0, limit);
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
  maxTxs: number
): Promise<FullScanResult> {
  const walletTrades = await fetchAllWalletTradesForToken(mint, maxTxs);

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
