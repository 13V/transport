/**
 * WALLET ALL-TIME SCORER
 *
 * Scores a single wallet on its ENTIRE realized trading history rather than a
 * recent window. Pulls the wallet's full swap history via the wallet-history
 * fetcher and runs it through the accurate FIFO PnL engine (accurate-pnl.ts) to
 * derive the headline number users care about: "up X% all-time".
 *
 *   - realizedPnlSol : total realized PnL (SOL) closed out across all tokens
 *   - investedSol    : cost basis of the SOLD quantity — the ROI denominator
 *   - roiPct         : realizedPnlSol / investedSol * 100  ← the "up X%" figure
 *
 * ROI uses the cost of what was actually sold (not all capital ever deployed),
 * so it reflects real realized return. Requires HELIUS_API_KEY.
 */

import { fetchWalletSwapHistory } from './wallet-history-fetcher';
import { computeAccuratePnL } from './accurate-pnl';

export interface WalletAllTimeScore {
  wallet: string;
  realizedPnlSol: number; // total realized PnL in SOL across all tokens
  investedSol: number; // cost basis of sold quantity (ROI denominator)
  roiPct: number; // realizedPnlSol / investedSol * 100, 0 when nothing realized
  winRate: number; // 0..1 over realized events
  consistency: number; // share of closed tokens that were net-positive
  tokensTraded: number; // distinct tokens touched
  closedTokens: number; // tokens with at least one realized (sold) event
  realizedEvents: number; // count of realized sell↔lot matches
  remainingCostSol: number; // cost basis still held (open exposure)
  unmatchedSoldSol: number; // proceeds from sells whose buys predate history
  totalTrades: number; // trades fed into the engine
  tradesScanned: number; // trades returned by the history fetch
  lastTradeAt: string | null; // ISO date of the most recent trade, or null
}

export async function scoreWalletAllTime(
  wallet: string,
  opts?: { maxTxs?: number }
): Promise<WalletAllTimeScore> {
  const trades = await fetchWalletSwapHistory(wallet, opts?.maxTxs ?? 1500);
  const pnl = computeAccuratePnL(trades);

  return {
    wallet,
    realizedPnlSol: pnl.realizedPnlSol,
    investedSol: pnl.investedSol,
    roiPct: pnl.roiPct,
    winRate: pnl.winRate,
    consistency: pnl.consistency,
    tokensTraded: pnl.tokensTraded,
    closedTokens: pnl.closedTokens,
    realizedEvents: pnl.realizedEvents,
    remainingCostSol: pnl.remainingCostSol,
    unmatchedSoldSol: pnl.unmatchedSoldSol,
    totalTrades: pnl.totalTrades,
    tradesScanned: trades.length,
    lastTradeAt: pnl.lastTradeAt ? pnl.lastTradeAt.toISOString() : null,
  };
}
