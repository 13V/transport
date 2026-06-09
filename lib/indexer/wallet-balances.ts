/**
 * NATIVE SOL BALANCES (Helius RPC getMultipleAccounts)
 *
 * A cheap balance snapshot — 1 credit per 100-address call, bounded by the daily
 * Helius credit circuit-breaker — used to flag "drained" verified winners: a
 * near-zero balance despite real realized PnL means the trader extracted profits
 * and/or moved to a fresh wallet, so we PRIORITIZE link-tracking them to find the
 * successor fast (instead of waiting for the slow full-set rotation).
 */

import axios from 'axios';
import { guardHeliusPage, recordSpend } from './helius-budget';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Return native SOL balance for each wallet via batched getMultipleAccounts.
 * Wallets the call couldn't cover (budget cap / transient error) are simply
 * absent from the map so callers can leave them unstamped for a later retry.
 */
export async function fetchSolBalances(wallets: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const key = process.env.HELIUS_API_KEY;
  if (!key || wallets.length === 0) return out;
  const endpoint = `https://mainnet.helius-rpc.com/?api-key=${key}`;

  for (let i = 0; i < wallets.length; i += 100) {
    const batch = wallets.slice(i, i + 100);
    // Each getMultipleAccounts call is ~1 credit; respect the daily cap.
    if (!(await guardHeliusPage(1))) break;
    try {
      const { data } = await axios.post(
        endpoint,
        {
          jsonrpc: '2.0',
          id: 'bal',
          method: 'getMultipleAccounts',
          // dataSlice length:0 — we only need lamports, not account data.
          params: [batch, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }],
        },
        { timeout: 15000 }
      );
      await recordSpend(1);
      const vals = data?.result?.value;
      if (!Array.isArray(vals)) continue;
      batch.forEach((w, idx) => {
        const acc = vals[idx];
        // A wallet's lamports = its SOL balance; a null account (never funded or
        // fully swept) reads as 0 — exactly the "drained" signal we want.
        out.set(w, acc ? Number(acc.lamports || 0) / LAMPORTS_PER_SOL : 0);
      });
    } catch {
      break; // transient — stop; leave the rest for the next run
    }
  }
  return out;
}
