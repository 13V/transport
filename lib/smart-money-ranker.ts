/**
 * SMART MONEY RANKER: Algorithm to rank wallets across all tokens
 *
 * This module implements the core ranking algorithm that aggregates multiple
 * metrics into a unified RankScore for each wallet. The algorithm handles:
 * - Cross-token aggregation (sum PnL across tokens)
 * - Wallet deduplication (same address across multiple tokens)
 * - Recency weighting (prioritize recent activity)
 * - Confidence filtering (exclude low-data wallets)
 *
 * RANKING FORMULA:
 * ================
 * RankScore = (SmartMoneyScore × 0.5) +
 *             (normalizedPnL × 0.2) +
 *             (winRate × 100 × 0.15) +
 *             (consistency × 0.15)
 *
 * Final rank: Sort by RankScore (descending), with top 100 selected
 */

import type { SmartMoneyScore } from './wallet-analyzer';

export interface WalletRankingMetrics {
  address: string;
  smartMoneyScore: number; // 0-100 from Agent 6
  normalizedPnL: number; // normalized to 0-100 scale
  winRate: number; // 0-1
  consistency: number; // 0-100
  totalPnL: number; // raw SOL value
  totalTrades: number;
  tokensHeld: number;
  lastActivityTime: Date;
  confidence: number; // 0-1, based on data quality
}

export interface RankedWallet {
  rank: number;
  address: string;
  rankScore: number; // 0-100
  smartMoneyScore: number;
  pnl: number; // total PnL in SOL
  winRate: number; // 0-1
  consistency: number; // 0-100
  tokensHeld: number;
  totalTrades: number;
  lastActivityTime: Date;
  confidence: number; // data quality indicator
}

/**
 * Normalize PnL to 0-100 scale using percentile-based approach
 * Accounts for both positive and negative PnL values
 *
 * Strategy:
 * - Separate positive and negative PnL
 * - Rank within each group
 * - Map to 50-100 for positive, 0-50 for negative
 * - This ensures consistent scaling regardless of market conditions
 */
export function normalizePnL(pnl: number, allPnLValues: number[]): number {
  if (allPnLValues.length === 0) return 50;

  // Separate positive and negative values
  const positiveValues = allPnLValues.filter(v => v > 0);
  const negativeValues = allPnLValues.filter(v => v < 0);
  const zeroCount = allPnLValues.length - positiveValues.length - negativeValues.length;

  if (pnl > 0) {
    if (positiveValues.length === 0) return 75; // Rare: only positive value
    const percentile = positiveValues.filter(v => v <= pnl).length / positiveValues.length;
    return 50 + (percentile * 50); // Map to 50-100 range
  } else if (pnl < 0) {
    if (negativeValues.length === 0) return 25; // Rare: only negative value
    const percentile = negativeValues.filter(v => v >= pnl).length / negativeValues.length;
    return percentile * 50; // Map to 0-50 range
  } else {
    // pnl === 0
    return 50; // Neutral
  }
}

/**
 * Calculate RankScore from aggregated metrics
 *
 * Formula (as per brief):
 * RankScore = (SmartMoneyScore × 0.5) +
 *             (normalizedPnL × 0.2) +
 *             (winRate × 100 × 0.15) +
 *             (consistency × 0.15)
 *
 * @param metrics Aggregated wallet metrics
 * @returns RankScore 0-100
 */
export function calculateRankScore(metrics: WalletRankingMetrics): number {
  const smartMoneyComponent = metrics.smartMoneyScore * 0.5;
  const pnlComponent = metrics.normalizedPnL * 0.2;
  const winRateComponent = (metrics.winRate * 100) * 0.15;
  const consistencyComponent = metrics.consistency * 0.15;

  const rankScore = smartMoneyComponent + pnlComponent + winRateComponent + consistencyComponent;

  // Clamp to 0-100 range
  return Math.max(0, Math.min(100, rankScore));
}

/**
 * Filter wallets based on confidence thresholds
 * Exclude low-quality data wallets to improve ranking reliability
 *
 * Confidence factors:
 * - Minimum 3 trades required
 * - Minimum 7 days of activity history
 * - At least 2 tokens held
 */
export function filterByConfidence(
  wallets: WalletRankingMetrics[],
  minTrades: number = 3,
  minTokens: number = 2,
  minDaysActive: number = 7
): WalletRankingMetrics[] {
  const now = new Date();
  const minActivityDate = new Date(now.getTime() - minDaysActive * 24 * 60 * 60 * 1000);

  return wallets.filter(wallet => {
    const hasMinTrades = wallet.totalTrades >= minTrades;
    const hasMinTokens = wallet.tokensHeld >= minTokens;
    const hasMinActivity = wallet.lastActivityTime >= minActivityDate;

    // Calculate confidence score
    const tradesScore = Math.min(wallet.totalTrades / 10, 1); // Normalize to 0-1
    const tokensScore = Math.min(wallet.tokensHeld / 5, 1); // Normalize to 0-1
    const activityDays = (now.getTime() - wallet.lastActivityTime.getTime()) / (24 * 60 * 60 * 1000);
    const activityScore = Math.min(activityDays / minDaysActive, 1);

    wallet.confidence = (tradesScore * 0.4) + (tokensScore * 0.3) + (activityScore * 0.3);

    // Include wallets that meet ALL minimum criteria
    return hasMinTrades && hasMinTokens && hasMinActivity;
  });
}

/**
 * Deduplicate wallets by address
 * Aggregates metrics for same wallet across multiple tokens
 *
 * When same wallet appears multiple times (from different tokens):
 * - PnL and trades: SUM across all tokens
 * - SmartMoneyScore, winRate, consistency: AVERAGE (weighted by token count)
 * - tokensHeld: COUNT of unique tokens
 * - lastActivityTime: MOST RECENT
 */
export function deduplicateWallets(
  wallets: WalletRankingMetrics[]
): Map<string, WalletRankingMetrics> {
  const deduped = new Map<string, WalletRankingMetrics>();

  for (const wallet of wallets) {
    const address = wallet.address.toLowerCase();

    if (deduped.has(address)) {
      const existing = deduped.get(address)!;

      // Aggregate metrics
      existing.totalPnL += wallet.totalPnL;
      existing.totalTrades += wallet.totalTrades;
      existing.tokensHeld += 1; // Count this as another token

      // Update last activity to most recent
      if (wallet.lastActivityTime > existing.lastActivityTime) {
        existing.lastActivityTime = wallet.lastActivityTime;
      }

      // Weighted average of scores (weight by number of tokens)
      const oldWeight = existing.tokensHeld - 1;
      const newWeight = 1;
      const totalWeight = oldWeight + newWeight;

      existing.smartMoneyScore =
        (existing.smartMoneyScore * oldWeight + wallet.smartMoneyScore * newWeight) / totalWeight;
      existing.winRate =
        (existing.winRate * oldWeight + wallet.winRate * newWeight) / totalWeight;
      existing.consistency =
        (existing.consistency * oldWeight + wallet.consistency * newWeight) / totalWeight;
    } else {
      // New wallet - create entry
      deduped.set(address, {
        ...wallet,
        address: address,
        tokensHeld: 1,
      });
    }
  }

  return deduped;
}

/**
 * Rank wallets according to RankScore
 *
 * Steps:
 * 1. Deduplicate by address
 * 2. Filter by confidence (exclude low-quality data)
 * 3. Normalize PnL values
 * 4. Calculate RankScore for each
 * 5. Sort by RankScore (descending)
 * 6. Assign ranks 1-100
 * 7. Return top 100
 *
 * @param wallets Input wallets with metrics
 * @param maxRanked Number of wallets to rank (default 100)
 * @returns Array of top ranked wallets (max 100)
 */
export function rankWallets(
  wallets: WalletRankingMetrics[],
  maxRanked: number = 100
): RankedWallet[] {
  if (wallets.length === 0) return [];

  // Step 1: Deduplicate
  const dedupedMap = deduplicateWallets(wallets);
  const dedupedWallets = Array.from(dedupedMap.values());

  // Step 2: Filter by confidence
  const filteredWallets = filterByConfidence(dedupedWallets);

  if (filteredWallets.length === 0) return [];

  // Step 3: Normalize PnL
  const allPnLValues = filteredWallets.map(w => w.totalPnL);
  filteredWallets.forEach(wallet => {
    wallet.normalizedPnL = normalizePnL(wallet.totalPnL, allPnLValues);
  });

  // Step 4: Calculate RankScore
  const scored = filteredWallets.map(wallet => ({
    wallet,
    rankScore: calculateRankScore(wallet),
  }));

  // Step 5: Sort by RankScore (descending) - higher score is better
  scored.sort((a, b) => b.rankScore - a.rankScore);

  // Step 6 & 7: Assign ranks and return top 100
  return scored.slice(0, maxRanked).map((item, index) => ({
    rank: index + 1,
    address: item.wallet.address,
    rankScore: item.rankScore,
    smartMoneyScore: item.wallet.smartMoneyScore,
    pnl: item.wallet.totalPnL,
    winRate: item.wallet.winRate,
    consistency: item.wallet.consistency,
    tokensHeld: item.wallet.tokensHeld,
    totalTrades: item.wallet.totalTrades,
    lastActivityTime: item.wallet.lastActivityTime,
    confidence: item.wallet.confidence,
  }));
}

/**
 * Calculate percentile rank for a wallet in the full population
 * Used for displaying "top X%" in UI
 *
 * @param walletAddress Address to find percentile for
 * @param allRankedWallets All ranked wallets (for context)
 * @returns Percentile 0-100 (100 = best)
 */
export function calculatePercentile(
  walletAddress: string,
  allRankedWallets: RankedWallet[]
): number {
  const wallet = allRankedWallets.find(w => w.address.toLowerCase() === walletAddress.toLowerCase());
  if (!wallet || allRankedWallets.length === 0) return 0;

  // Percentile = (1 - (rank - 1) / totalCount) * 100
  // Top wallet (rank 1) = 100th percentile
  // Bottom wallet = near 0th percentile
  const percentile = ((allRankedWallets.length - wallet.rank) / allRankedWallets.length) * 100;
  return Math.round(percentile);
}

/**
 * Get ranking statistics for display/analysis
 *
 * @param rankedWallets List of ranked wallets
 * @returns Statistics object
 */
export interface RankingStatistics {
  totalWallets: number;
  topRankedCount: number;
  averageRankScore: number;
  medianRankScore: number;
  averagePnL: number;
  averageWinRate: number;
  scoreDistribution: {
    excellent: number; // 80-100
    good: number; // 60-79
    fair: number; // 40-59
    poor: number; // <40
  };
}

export function getRankingStatistics(rankedWallets: RankedWallet[]): RankingStatistics {
  if (rankedWallets.length === 0) {
    return {
      totalWallets: 0,
      topRankedCount: 0,
      averageRankScore: 0,
      medianRankScore: 0,
      averagePnL: 0,
      averageWinRate: 0,
      scoreDistribution: {
        excellent: 0,
        good: 0,
        fair: 0,
        poor: 0,
      },
    };
  }

  const scores = rankedWallets.map(w => w.rankScore);
  const averageRankScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sortedScores = [...scores].sort((a, b) => a - b);
  const medianRankScore = sortedScores[Math.floor(sortedScores.length / 2)];

  const averagePnL = rankedWallets.reduce((sum, w) => sum + w.pnl, 0) / rankedWallets.length;
  const averageWinRate = rankedWallets.reduce((sum, w) => sum + w.winRate, 0) / rankedWallets.length;

  const scoreDistribution = {
    excellent: rankedWallets.filter(w => w.rankScore >= 80).length,
    good: rankedWallets.filter(w => w.rankScore >= 60 && w.rankScore < 80).length,
    fair: rankedWallets.filter(w => w.rankScore >= 40 && w.rankScore < 60).length,
    poor: rankedWallets.filter(w => w.rankScore < 40).length,
  };

  return {
    totalWallets: rankedWallets.length,
    topRankedCount: rankedWallets.length,
    averageRankScore,
    medianRankScore,
    averagePnL,
    averageWinRate,
    scoreDistribution,
  };
}
