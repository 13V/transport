/**
 * SWAP FETCHER
 *
 * Pulls real DEX swaps for a token from the Helius Enhanced Transactions API
 * and parses them into Trade objects the PnL engine understands.
 *
 * Requires HELIUS_API_KEY (the paid plan). Without it, returns [].
 *
 * Helius enhanced swap shape (events.swap):
 *   nativeInput / nativeOutput : { account, amount }      // lamports
 *   tokenInputs / tokenOutputs : [{ userAccount, mint, rawTokenAmount:{tokenAmount, decimals} }]
 *
 * Interpretation for the swapper (tx.feePayer):
 *   - paid SOL (nativeInput) + received target token (tokenOutput) => BUY
 *   - sent target token (tokenInput) + received SOL (nativeOutput)  => SELL
 */

import axios from 'axios';
import type { Trade } from '../pnl-engine';

const LAMPORTS_PER_SOL = 1_000_000_000;

function heliusBase(): string | null {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://api.helius.xyz/v0` : null;
}

interface RawTokenAmount {
  tokenAmount?: string | number;
  decimals?: number;
}

function tokenUi(entry: any): number {
  const raw: RawTokenAmount | undefined = entry?.rawTokenAmount;
  if (raw && raw.tokenAmount != null && raw.decimals != null) {
    return Number(raw.tokenAmount) / Math.pow(10, raw.decimals);
  }
  // Fallback to already-ui amount if present
  return Number(entry?.tokenAmount ?? 0);
}

/**
 * Fetch and parse recent swaps involving `mint`.
 * Returns Trade objects (one per swapper per swap) for the target mint only.
 */
export async function fetchSwapsForToken(
  mint: string,
  limit = 100
): Promise<Trade[]> {
  const base = heliusBase();
  if (!base) {
    console.warn('[SWAPS] HELIUS_API_KEY not set — cannot fetch real swaps');
    return [];
  }

  const url = `${base}/addresses/${mint}/transactions`;
  let txs: any[] = [];
  try {
    const { data } = await axios.get(url, {
      params: {
        'api-key': process.env.HELIUS_API_KEY,
        type: 'SWAP',
        limit,
      },
      timeout: 20000,
    });
    txs = Array.isArray(data) ? data : [];
  } catch (err) {
    const status = (err as any)?.response?.status;
    console.error(`[SWAPS] Failed for ${mint} (status ${status}):`, (err as Error).message);
    return [];
  }

  const trades: Trade[] = [];

  for (const tx of txs) {
    const swap = tx?.events?.swap;
    const feePayer: string | undefined = tx?.feePayer;
    const sig: string = tx?.signature ?? '';
    const ts: number = tx?.timestamp ?? 0;
    if (!swap || !feePayer || !sig) continue;

    const nativeInLamports = Number(swap?.nativeInput?.amount ?? 0);
    const nativeOutLamports = Number(swap?.nativeOutput?.amount ?? 0);

    // Did the swapper receive the target token? (BUY)
    const boughtEntry = (swap.tokenOutputs ?? []).find(
      (t: any) => t?.mint === mint
    );
    // Did the swapper send the target token? (SELL)
    const soldEntry = (swap.tokenInputs ?? []).find(
      (t: any) => t?.mint === mint
    );

    if (boughtEntry && nativeInLamports > 0) {
      const tokenAmount = tokenUi(boughtEntry);
      const solAmount = nativeInLamports / LAMPORTS_PER_SOL;
      if (tokenAmount > 0 && solAmount > 0) {
        trades.push({
          tokenMint: mint,
          tradeType: 'BUY',
          amount: tokenAmount,
          pricePerToken: solAmount / tokenAmount,
          date: new Date(ts * 1000),
          txHash: sig,
          source: 'JUPITER',
        });
      }
    } else if (soldEntry && nativeOutLamports > 0) {
      const tokenAmount = tokenUi(soldEntry);
      const solAmount = nativeOutLamports / LAMPORTS_PER_SOL;
      if (tokenAmount > 0 && solAmount > 0) {
        trades.push({
          tokenMint: mint,
          tradeType: 'SELL',
          amount: tokenAmount,
          pricePerToken: solAmount / tokenAmount,
          date: new Date(ts * 1000),
          txHash: sig,
          source: 'JUPITER',
        });
      }
    }
  }

  return trades;
}

/**
 * Like fetchSwapsForToken, but also tags each trade with the swapper wallet.
 * (Trade has no wallet field, so the indexer needs this pairing to attribute
 * trades to wallets when writing to the DB.)
 */
export interface WalletTrade {
  wallet: string;
  trade: Trade;
}

export async function fetchWalletTradesForToken(
  mint: string,
  limit = 100
): Promise<WalletTrade[]> {
  const base = heliusBase();
  if (!base) return [];

  const url = `${base}/addresses/${mint}/transactions`;
  let txs: any[] = [];
  try {
    const { data } = await axios.get(url, {
      params: { 'api-key': process.env.HELIUS_API_KEY, type: 'SWAP', limit },
      timeout: 20000,
    });
    txs = Array.isArray(data) ? data : [];
  } catch (err) {
    const status = (err as any)?.response?.status;
    console.error(`[SWAPS] Failed for ${mint} (status ${status}):`, (err as Error).message);
    return [];
  }

  const out: WalletTrade[] = [];
  for (const tx of txs) {
    const swap = tx?.events?.swap;
    const wallet: string | undefined = tx?.feePayer;
    const sig: string = tx?.signature ?? '';
    const ts: number = tx?.timestamp ?? 0;
    if (!swap || !wallet || !sig) continue;

    const nativeInLamports = Number(swap?.nativeInput?.amount ?? 0);
    const nativeOutLamports = Number(swap?.nativeOutput?.amount ?? 0);
    const boughtEntry = (swap.tokenOutputs ?? []).find((t: any) => t?.mint === mint);
    const soldEntry = (swap.tokenInputs ?? []).find((t: any) => t?.mint === mint);

    if (boughtEntry && nativeInLamports > 0) {
      const tokenAmount = tokenUi(boughtEntry);
      const solAmount = nativeInLamports / LAMPORTS_PER_SOL;
      if (tokenAmount > 0 && solAmount > 0) {
        out.push({
          wallet,
          trade: {
            tokenMint: mint,
            tradeType: 'BUY',
            amount: tokenAmount,
            pricePerToken: solAmount / tokenAmount,
            date: new Date(ts * 1000),
            txHash: sig,
            source: 'JUPITER',
          },
        });
      }
    } else if (soldEntry && nativeOutLamports > 0) {
      const tokenAmount = tokenUi(soldEntry);
      const solAmount = nativeOutLamports / LAMPORTS_PER_SOL;
      if (tokenAmount > 0 && solAmount > 0) {
        out.push({
          wallet,
          trade: {
            tokenMint: mint,
            tradeType: 'SELL',
            amount: tokenAmount,
            pricePerToken: solAmount / tokenAmount,
            date: new Date(ts * 1000),
            txHash: sig,
            source: 'JUPITER',
          },
        });
      }
    }
  }
  return out;
}
