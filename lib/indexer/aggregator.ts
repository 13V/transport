/**
 * AGGREGATOR
 *
 * Turns a wallet's raw trades into leaderboard stats using the real PnL engine.
 *
 * SmartMoneyScore (0-100), weighted:
 *   40% PnL (realized, normalized)  +  30% win rate
 *   15% consistency (share of profitable tokens)  +  15% activity
 */

import { TradeProcessor, type Trade } from '../pnl-engine';

export interface WalletStat {
  wallet: string;
  score: number;
  realizedPnl: number;
  winRate: number;
  consistency: number;
  totalTrades: number;
  tokensTraded: number;
  lastTradeAt: Date | null;
}

/** Normalize realized PnL (SOL) to 0..1. 10 SOL realized => full marks. */
function normalizePnl(realizedSol: number): number {
  if (realizedSol <= 0) return 0;
  return Math.min(1, realizedSol / 10);
}

/** Normalize trade count to 0..1 as an activity proxy. 50 trades => full. */
function normalizeActivity(trades: number): number {
  if (trades <= 0) return 0;
  return Math.min(1, trades / 50);
}

export function aggregateWallet(wallet: string, trades: Trade[]): WalletStat {
  const processor = new TradeProcessor();
  processor.addTrades(trades);
  const pnl = processor.calculatePnL();

  // Consistency = share of traded tokens that ended net-positive realized.
  let profitableTokens = 0;
  let totalTokens = 0;
  for (const summary of pnl.byToken.values()) {
    totalTokens += 1;
    if (summary.realizedPnL > 0) profitableTokens += 1;
  }
  const consistency = totalTokens > 0 ? profitableTokens / totalTokens : 0;

  const pnlScore = normalizePnl(pnl.totalRealizedPnL);
  const activityScore = normalizeActivity(pnl.totalTrades);

  const score =
    100 *
    (0.4 * pnlScore +
      0.3 * pnl.winRate +
      0.15 * consistency +
      0.15 * activityScore);

  // Most recent trade date across all trades.
  let lastTradeAt: Date | null = null;
  for (const t of trades) {
    if (!lastTradeAt || t.date > lastTradeAt) lastTradeAt = t.date;
  }

  return {
    wallet,
    score: Math.round(score * 100) / 100,
    realizedPnl: Math.round(pnl.totalRealizedPnL * 10000) / 10000,
    winRate: Math.round(pnl.winRate * 10000) / 10000,
    consistency: Math.round(consistency * 10000) / 10000,
    totalTrades: pnl.totalTrades,
    tokensTraded: totalTokens,
    lastTradeAt,
  };
}
