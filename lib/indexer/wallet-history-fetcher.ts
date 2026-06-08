/**
 * WALLET HISTORY FETCHER
 *
 * The wallet-first counterpart to swap-fetcher's token-first scan. Pulls a
 * single wallet's full DEX swap history from the Helius Enhanced Transactions
 * API and parses each swap into Trade objects (reusing swap-fetcher's net-delta
 * parser via parseWalletTradesFromTx).
 *
 * Used to deep-scan curated "alpha" seed wallets so they land on the leaderboard
 * scored from their own real trading history.
 *
 * Requires HELIUS_API_KEY. Without it, returns [].
 */

import axios from 'axios';
import { parseWalletTradesFromTx } from './swap-fetcher';
import { guardHeliusPage, recordSpend } from './helius-budget';
import type { Trade } from '../pnl-engine';

const HELIUS_PAGE_SIZE = 100; // Helius caps enhanced-tx pages at 100.

function heliusBase(): string | null {
  // Same host swap-fetcher uses; the legacy api.helius.xyz rejects newer keys.
  return process.env.HELIUS_API_KEY ? `https://api-mainnet.helius-rpc.com/v0` : null;
}

/**
 * Fetch and parse up to `maxTxs` of a wallet's recent SWAP transactions,
 * returning SOL-quoted Trade objects ordered as Helius returns them (newest
 * first). Paginates via the `before` signature cursor.
 */
export async function fetchWalletSwapHistory(
  wallet: string,
  maxTxs = 1000
): Promise<{ trades: Trade[]; complete: boolean }> {
  const base = heliusBase();
  if (!base) {
    console.warn('[SEED] HELIUS_API_KEY not set — cannot fetch wallet history');
    // No key ⇒ this is NOT a real "we scanned and found nothing" result.
    return { trades: [], complete: false };
  }

  const url = `${base}/addresses/${wallet}/transactions`;
  const trades: Trade[] = [];
  let before: string | undefined;
  let fetched = 0;
  // True only if we genuinely exhausted the wallet's history (an empty or
  // short final page). Set false if we stopped early — budget cap, a fetch
  // error, OR hitting maxTxs while the last page was still full (more history
  // almost certainly exists) — so callers don't persist partial PnL/ROI as if
  // it were the full all-time record, or verify a wallet on a truncated scan.
  let complete = true;

  while (fetched < maxTxs) {
    // Hard cost ceiling: stop paginating once the daily Helius credit cap is
    // reached. Mark INCOMPLETE so the caller leaves the wallet for a later run
    // rather than scoring/verifying it on a truncated history.
    if (!(await guardHeliusPage(100))) {
      complete = false;
      break;
    }

    const limit = Math.min(HELIUS_PAGE_SIZE, maxTxs - fetched);

    let txs: any[];
    try {
      const { data } = await axios.get(url, {
        params: {
          'api-key': process.env.HELIUS_API_KEY,
          type: 'SWAP',
          limit,
          ...(before ? { before } : {}),
        },
        timeout: 20000,
      });
      txs = Array.isArray(data) ? data : [];
      await recordSpend(100); // page succeeded -> 100 credits spent
    } catch (err) {
      const status = (err as any)?.response?.status;
      // An auth failure affects every wallet — surface it loudly instead of
      // silently returning a partial/empty history.
      if (status === 401 || status === 403) {
        throw new Error(`Helius auth failed (status ${status}) — check HELIUS_API_KEY`);
      }
      console.error(`[SEED] history fetch failed for ${wallet} (status ${status}):`, (err as Error).message);
      complete = false; // partial due to a transient fetch error — retry later
      break;
    }

    if (txs.length === 0) break; // genuinely no more history — a complete scan

    for (const tx of txs) {
      for (const trade of parseWalletTradesFromTx(tx, wallet)) trades.push(trade);
    }

    fetched += txs.length;
    before = txs[txs.length - 1]?.signature;
    if (!before || txs.length < limit) break; // short/final page — true exhaustion

    // The page was full and a cursor remains, so more history exists. If that
    // means we're now about to stop only because we hit maxTxs, this is a
    // TRUNCATED scan, not a complete one — flag it so the caller re-scans later
    // at greater depth rather than scoring/verifying on partial history.
    if (fetched >= maxTxs) {
      complete = false;
      break;
    }
  }

  return { trades, complete };
}
