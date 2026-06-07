/**
 * WALLET LINKAGE BY SOL FUNDING
 *
 * Detects when a wallet distributes SOL to OTHER wallets. When a known smart
 * wallet funds a fresh wallet, it's almost always the same trader on a new
 * wallet — so following SOL distributions lets us discover and keep tracking a
 * trader even when they switch wallets ("track them forever").
 *
 * Uses the Helius Enhanced Transactions API (type=TRANSFER) and reads each tx's
 * nativeTransfers for outgoing SOL from the wallet, above a meaningful size, to
 * non-infrastructure recipients.
 */

import axios from 'axios';
import { guardHeliusPage, recordSpend } from './helius-budget';

const LAMPORTS_PER_SOL = 1_000_000_000;

// Recipients that are never "a trader's new wallet": system/burn/infra. CEX hot
// wallets can be added via the LINK_DENY env (comma-separated).
const DENY = new Set<string>([
  '11111111111111111111111111111111', // System Program
  '1nc1nerator11111111111111111111111111111111', // Incinerator (burn)
]);

function denySet(): Set<string> {
  const extra = (process.env.LINK_DENY ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.length ? new Set([...DENY, ...extra]) : DENY;
}

function heliusBase(): string | null {
  return process.env.HELIUS_API_KEY ? `https://api-mainnet.helius-rpc.com/v0` : null;
}

export interface Distribution {
  target: string;
  amountSol: number; // total SOL sent to this target (within scanned window)
  transfers: number; // number of transfers
  firstSeen: Date;
  lastSeen: Date;
}

/**
 * Outgoing SOL distributions from `wallet`, aggregated per recipient. Only
 * transfers >= minSol to non-deny, non-self recipients are counted.
 */
export async function fetchSolDistributions(
  wallet: string,
  opts: { maxTxs?: number; minSol?: number } = {}
): Promise<Distribution[]> {
  const base = heliusBase();
  if (!base) return [];

  const maxTxs = opts.maxTxs ?? 500;
  const minSol = opts.minSol ?? 0.5;
  const deny = denySet();
  const url = `${base}/addresses/${wallet}/transactions`;

  const byTarget = new Map<string, Distribution>();
  let before: string | undefined;
  let fetched = 0;

  while (fetched < maxTxs) {
    // Hard cost ceiling: stop paginating once the daily Helius credit cap is
    // reached, returning whatever we've gathered so far.
    if (!(await guardHeliusPage(100))) break;

    const limit = Math.min(100, maxTxs - fetched);
    let txs: any[];
    try {
      const { data } = await axios.get(url, {
        params: {
          'api-key': process.env.HELIUS_API_KEY,
          type: 'TRANSFER',
          limit,
          ...(before ? { before } : {}),
        },
        timeout: 20000,
      });
      txs = Array.isArray(data) ? data : [];
      await recordSpend(100); // page succeeded -> 100 credits spent
    } catch (err) {
      const status = (err as any)?.response?.status;
      if (status === 401 || status === 403) {
        throw new Error(`Helius auth failed (status ${status}) — check HELIUS_API_KEY`);
      }
      console.error(`[LINKS] transfer page failed for ${wallet} (status ${status})`);
      break;
    }

    if (txs.length === 0) break;

    for (const tx of txs) {
      const ts = new Date((tx?.timestamp ?? 0) * 1000);
      const transfers: any[] = Array.isArray(tx?.nativeTransfers) ? tx.nativeTransfers : [];
      for (const nt of transfers) {
        if (nt?.fromUserAccount !== wallet) continue;
        const to = nt?.toUserAccount;
        if (!to || to === wallet || deny.has(to)) continue;
        const sol = Number(nt?.amount ?? 0) / LAMPORTS_PER_SOL;
        if (!(sol >= minSol)) continue;

        const cur = byTarget.get(to);
        if (cur) {
          cur.amountSol += sol;
          cur.transfers += 1;
          if (ts < cur.firstSeen) cur.firstSeen = ts;
          if (ts > cur.lastSeen) cur.lastSeen = ts;
        } else {
          byTarget.set(to, { target: to, amountSol: sol, transfers: 1, firstSeen: ts, lastSeen: ts });
        }
      }
    }

    fetched += txs.length;
    before = txs[txs.length - 1]?.signature;
    if (!before || txs.length < limit) break;
  }

  return [...byTarget.values()].sort((a, b) => b.amountSol - a.amountSol);
}
