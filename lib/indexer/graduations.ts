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

export interface GraduatedCoin {
  mint: string;
  symbol?: string;
}

/**
 * Recently-active graduated coins: PumpSwap pairs on Solana from DexScreener.
 * pump.fun mints (ending "pump") are prioritized.
 */
export async function getGraduatedCoins(limit = 30): Promise<GraduatedCoin[]> {
  try {
    const { data } = await axios.get(DEXSCREENER_SEARCH, {
      params: { q: 'pumpswap' },
      timeout: 12000,
    });
    const pairs: any[] = Array.isArray(data?.pairs) ? data.pairs : [];
    const seen = new Set<string>();
    const out: GraduatedCoin[] = [];
    for (const p of pairs) {
      if (p?.chainId !== 'solana') continue;
      if (p?.dexId !== 'pumpswap') continue;
      const mint: string | undefined = p?.baseToken?.address;
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      out.push({ mint, symbol: p?.baseToken?.symbol });
    }
    // pump.fun mints first.
    out.sort(
      (a, b) =>
        Number(b.mint.toLowerCase().endsWith('pump')) -
        Number(a.mint.toLowerCase().endsWith('pump'))
    );
    return out.slice(0, limit);
  } catch (err) {
    console.error('[GRAD] getGraduatedCoins failed:', (err as Error).message);
    return [];
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
