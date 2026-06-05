/**
 * SWAP FETCHER
 *
 * Pulls real DEX swaps for a token from the Helius Enhanced Transactions API
 * and parses them into Trade objects the PnL engine understands.
 *
 * Requires HELIUS_API_KEY. Without it, returns [].
 *
 * PARSING STRATEGY — net balance changes (not events.swap)
 * ------------------------------------------------------------------
 * Many DEXes (notably PUMP_AMM, the dominant venue for pump.fun coins) do NOT
 * populate `events.swap`, and aggregator swaps quote in wrapped SOL rather than
 * native lamports. So instead of trusting the parsed swap event, we read each
 * transaction's per-account balance deltas (`accountData`) and compute, for the
 * fee-paying wallet:
 *
 *   tokenDelta  = net change in the target mint
 *   solDelta    = net native SOL change  +  net wrapped-SOL (WSOL) change
 *
 *   tokenDelta > 0 & solDelta < 0  => BUY   (got tokens, paid SOL)
 *   tokenDelta < 0 & solDelta > 0  => SELL  (sent tokens, got SOL)
 *
 * Attributing to the fee payer (the signer) means liquidity-pool vaults,
 * gas relayers, and arbitrage bots all fall out naturally: pools aren't the
 * fee payer, relayers hold no target token, and arb bots net ~zero. Token-to-
 * token (e.g. USDC-quoted) swaps have solDelta ~ 0 and are skipped, since they
 * can't be priced in SOL.
 */

import axios from 'axios';
import type { Trade } from '../pnl-engine';

const LAMPORTS_PER_SOL = 1_000_000_000;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
// Ignore dust / fee-only noise (a few lamports of rent shouldn't count as a trade).
const MIN_SOL_VALUE = 0.001;

function heliusBase(): string | null {
  // Current Enhanced API host. The legacy api.helius.xyz host rejects newer
  // keys with 401 "Invalid API key".
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://api-mainnet.helius-rpc.com/v0` : null;
}

interface RawTokenAmount {
  tokenAmount?: string | number;
  decimals?: number;
}
interface TokenBalanceChange {
  userAccount?: string;
  tokenAccount?: string;
  mint?: string;
  rawTokenAmount?: RawTokenAmount;
}
interface AccountData {
  account?: string;
  nativeBalanceChange?: number;
  tokenBalanceChanges?: TokenBalanceChange[];
}

function rawToUi(r?: RawTokenAmount): number {
  if (!r || r.tokenAmount == null || r.decimals == null) return 0;
  const amt = Number(r.tokenAmount);
  if (!Number.isFinite(amt)) return 0;
  return amt / Math.pow(10, r.decimals);
}

export interface WalletTrade {
  wallet: string;
  trade: Trade;
}

/**
 * Parse a single enhanced transaction into one trade for `mint`, attributed to
 * the fee payer. Returns null when the fee payer isn't a clean SOL-quoted taker
 * of `mint`.
 */
export function parseTradeFromTx(tx: any, mint: string): WalletTrade | null {
  const wallet: string | undefined = tx?.feePayer;
  const sig: string = tx?.signature ?? '';
  const ts: number = tx?.timestamp ?? 0;
  if (!wallet || !sig) return null;

  const accountData: AccountData[] = Array.isArray(tx?.accountData) ? tx.accountData : [];

  let tokenDelta = 0; // fee payer's net change in target mint (ui units)
  let wsolDelta = 0; // fee payer's net change in wrapped SOL (ui units)
  let nativeLamports = 0; // fee payer's net native SOL change (lamports)

  for (const ad of accountData) {
    if (ad?.account === wallet && typeof ad?.nativeBalanceChange === 'number') {
      nativeLamports += ad.nativeBalanceChange;
    }
    for (const tbc of ad?.tokenBalanceChanges ?? []) {
      if (tbc?.userAccount !== wallet) continue;
      const ui = rawToUi(tbc?.rawTokenAmount);
      if (tbc?.mint === mint) tokenDelta += ui;
      else if (tbc?.mint === WSOL_MINT) wsolDelta += ui;
    }
  }

  if (tokenDelta === 0) return null; // fee payer isn't the taker of this mint

  const solDelta = nativeLamports / LAMPORTS_PER_SOL + wsolDelta;

  let tradeType: 'BUY' | 'SELL';
  let amount: number;
  let solAmount: number;

  if (tokenDelta > 0 && solDelta < 0) {
    tradeType = 'BUY';
    amount = tokenDelta;
    solAmount = -solDelta;
  } else if (tokenDelta < 0 && solDelta > 0) {
    tradeType = 'SELL';
    amount = -tokenDelta;
    solAmount = solDelta;
  } else {
    return null; // not SOL-quoted (e.g. USDC), or signs don't oppose
  }

  if (solAmount < MIN_SOL_VALUE || amount <= 0) return null;

  return {
    wallet,
    trade: {
      tokenMint: mint,
      tradeType,
      amount,
      pricePerToken: solAmount / amount,
      date: new Date(ts * 1000),
      txHash: sig,
      source: tx?.source ?? 'UNKNOWN',
    },
  };
}

async function fetchSwapTxs(mint: string, limit: number): Promise<any[]> {
  const base = heliusBase();
  if (!base) {
    console.warn('[SWAPS] HELIUS_API_KEY not set — cannot fetch real swaps');
    return [];
  }

  const url = `${base}/addresses/${mint}/transactions`;
  try {
    const { data } = await axios.get(url, {
      params: { 'api-key': process.env.HELIUS_API_KEY, type: 'SWAP', limit },
      timeout: 20000,
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    const status = (err as any)?.response?.status;
    // An auth failure affects every token — surface it instead of pretending
    // the token simply had no swaps (which masks the real problem).
    if (status === 401 || status === 403) {
      throw new Error(`Helius auth failed (status ${status}) — check HELIUS_API_KEY`);
    }
    console.error(`[SWAPS] Failed for ${mint} (status ${status}):`, (err as Error).message);
    return [];
  }
}

/**
 * Fetch and parse recent swaps involving `mint`, each tagged with the swapper
 * wallet, for writing to the DB.
 */
export async function fetchWalletTradesForToken(
  mint: string,
  limit = 100
): Promise<WalletTrade[]> {
  const txs = await fetchSwapTxs(mint, limit);
  const out: WalletTrade[] = [];
  for (const tx of txs) {
    const wt = parseTradeFromTx(tx, mint);
    if (wt) out.push(wt);
  }
  return out;
}

/**
 * Like fetchWalletTradesForToken, but returns plain Trade objects (no wallet).
 */
export async function fetchSwapsForToken(mint: string, limit = 100): Promise<Trade[]> {
  const wts = await fetchWalletTradesForToken(mint, limit);
  return wts.map((w) => w.trade);
}
