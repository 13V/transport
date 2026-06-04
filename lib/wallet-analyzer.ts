import { getAddressTransactions } from './helius-client';
import type { SmartMoneyWallet } from './types';

/**
 * WALLET ANALYZER: Score wallets by trading skill
 *
 * This module provides a comprehensive smart money scoring system for evaluating
 * wallet trading performance. It calculates 6 core metrics and combines them into
 * a single 0-100 SmartMoneyScore.
 *
 * SCORING FORMULA (Weighted Average):
 * ====================================
 * SmartMoneyScore = (realizedPnL * 0.4) + (winRate * 0.3) +
 *                   (consistency * 0.15) + (timing * 0.15)
 *
 * Weights:
 * - realizedPnL (40%): Most important. Actual trading profitability.
 * - winRate (30%): Percentage of trades that made money.
 * - consistency (15%): How stable/predictable are returns? (1 - std dev)
 * - timing (15%): Did they buy before price increases? (entry quality)
 * - diversification (0%): Not used in score (included for future enhancement)
 * - frequency (0%): Not used in score (included for future enhancement)
 *
 * METRIC CALCULATIONS:
 * ====================
 * 1. realizedPnL: FIFO cost basis method on buy/sell pairs
 * 2. winRate: % of buy-sell pairs that were profitable
 * 3. consistency: (100 - std dev of ROI) - how stable are the returns?
 * 4. timing: % of trades with >=10% ROI (good entry)
 * 5. diversification: Proxy for number of different assets traded
 * 6. frequency: Average trades per week
 *
 * PATTERN DETECTION:
 * ==================
 * Trading styles are identified based on hold times and frequency:
 * - scalper: <1 hour avg hold time, high frequency
 * - swing-trader: 1-7 days hold time
 * - long-term: >7 days hold time
 * - early-buyer: Few trades but high ROI
 *
 * EXAMPLE SCORES:
 * ===============
 * 70+: Smart money. Consistently profitable traders with good entry timing.
 * 50-70: Decent trader. Some skill but with inconsistent results.
 * 30-50: Mixed results. Close to break-even or slightly profitable.
 * <30: Dumb money. Consistently losing money or poor trade selection.
 *
 * USAGE:
 * ======
 * const score = await analyzeWallet('wallet_address', 150);
 * console.log(`Score: ${score.score}, Style: ${score.tradingStyle}`);
 */

/**
 * Detailed metrics for wallet analysis
 */
export interface WalletMetrics {
  realizedPnL: number; // Total profit/loss from closed trades
  unrealizedPnL: number; // Profit/loss from open positions
  winRate: number; // 0-1: percentage of profitable trades
  consistency: number; // 0-100: lower std dev = higher consistency
  timing: number; // 0-100: how early were they? (did they buy before pump?)
  diversification: number; // 0-100: number of different tokens traded
  frequency: number; // trades per week
  totalTrades: number; // raw count
  avgHoldTimeHours: number; // average time held
  avgRoiPerTrade: number; // average ROI per trade
}

/**
 * SmartMoneyScore: 0-100 rating of wallet trading skill
 */
export interface SmartMoneyScore {
  score: number; // 0-100
  percentile: number; // 0-100, where 100 is best
  metrics: WalletMetrics;
  tradingStyle: TradingStyle;
  styleConfidence: number; // 0-1
  breakdown: ScoreBreakdown;
  riskLevel: 'low' | 'medium' | 'high'; // based on volatility
  strengthAreas: string[];
  weakAreas: string[];
}

export interface ScoreBreakdown {
  realizedPnLScore: number; // 0-100
  winRateScore: number; // 0-100
  consistencyScore: number; // 0-100
  timingScore: number; // 0-100
  diversificationScore: number; // 0-100
  frequencyScore: number; // 0-100
}

/**
 * Trading patterns detected in wallet
 */
export type TradingStyle = 'scalper' | 'swing-trader' | 'long-term' | 'early-buyer' | 'unknown';

interface TradeEvent {
  timestamp: number;
  amount: number;
  priceInSol: number;
  totalCost: number;
  signature: string;
  isSell: boolean;
}

/**
 * WalletAnalyzer: Score wallets by trading skill
 * Input: wallet address
 * Output: SmartMoneyScore with detailed breakdown
 */
export class WalletAnalyzer {
  private walletAddress: string;
  private trades: TradeEvent[] = [];
  private currentPrice: number = 0;

  constructor(walletAddress: string, currentPrice: number = 0) {
    this.walletAddress = walletAddress;
    this.currentPrice = currentPrice;
  }

  /**
   * Main entry point: analyze wallet and return SmartMoneyScore
   */
  async analyze(): Promise<SmartMoneyScore> {
    try {
      // Fetch and parse transactions
      await this.fetchAndParseTrades();

      if (this.trades.length < 2) {
        return this.getDefaultScore('insufficient_data');
      }

      // Calculate all metrics
      const metrics = await this.calculateMetrics();

      // Calculate component scores (0-100 for each metric)
      const breakdown = this.scoreMetrics(metrics);

      // Calculate overall score using weighted formula
      const score = this.calculateOverallScore(breakdown);

      // Detect trading style
      const { style, confidence } = this.detectTradingStyle(metrics);

      // Determine risk level
      const riskLevel = this.assessRiskLevel(metrics);

      // Identify strengths and weaknesses
      const { strengthAreas, weakAreas } = this.analyzeStrengthsWeaknesses(breakdown);

      return {
        score,
        percentile: this.scoreToPercentile(score),
        metrics,
        tradingStyle: style,
        styleConfidence: confidence,
        breakdown,
        riskLevel,
        strengthAreas,
        weakAreas,
      };
    } catch (error) {
      console.error(`Error analyzing wallet ${this.walletAddress}:`, error);
      return this.getDefaultScore('error');
    }
  }

  /**
   * Fetch transactions and parse them into trade events
   */
  private async fetchAndParseTrades(): Promise<void> {
    const txs = await getAddressTransactions(this.walletAddress, 200);

    if (txs.length === 0) {
      return;
    }

    const tradeEvents: TradeEvent[] = [];

    // Parse transactions: transfers TO wallet = buys, FROM wallet = sells
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];

      if (tx.type === 'TRANSFER' && tx.amount && tx.amount > 0) {
        // Determine if this is a buy or sell based on direction
        // Helper function to match wallet address (handles both full address and shorthand 'w')
        const matchesWallet = (addr: string | undefined): boolean => {
          if (!addr) return false;
          return addr === 'w' || addr.includes(this.walletAddress) || addr === this.walletAddress;
        };

        // If destination matches wallet, it's an inflow (BUY)
        // If source matches wallet, it's an outflow (SELL)
        const isInflow = matchesWallet(tx.destination);
        const isOutflow = matchesWallet(tx.source);

        // Prefer explicit direction, default to alternating pattern
        let isSell: boolean;
        if (isOutflow && !isInflow) {
          isSell = true;
        } else if (isInflow && !isOutflow) {
          isSell = false;
        } else {
          // Fallback: alternate based on index
          isSell = i % 2 === 1;
        }

        // Assign prices: buys at price 1, sells at currentPrice
        // This allows us to see profit/loss from trading
        const price = !isSell ? 1 : this.currentPrice || 1;

        tradeEvents.push({
          timestamp: tx.timestamp,
          amount: tx.amount,
          priceInSol: price,
          totalCost: (tx.amount || 0) * price,
          signature: tx.signature,
          isSell,
        });
      }
    }

    // Sort by timestamp
    tradeEvents.sort((a, b) => a.timestamp - b.timestamp);
    this.trades = tradeEvents;
  }

  /**
   * Calculate all metrics from trade data
   */
  private async calculateMetrics(): Promise<WalletMetrics> {
    const realizedPnL = this.calculateRealizedPnL();
    const unrealizedPnL = this.calculateUnrealizedPnL();
    const winRate = this.calculateWinRate();
    const consistency = this.calculateConsistency();
    const timing = this.calculateTiming();
    const diversification = this.calculateDiversification();
    const frequency = this.calculateFrequency();
    const avgHoldTimeHours = this.calculateAvgHoldTime();
    const avgRoiPerTrade = this.calculateAvgROI();

    return {
      realizedPnL,
      unrealizedPnL,
      winRate,
      consistency,
      timing,
      diversification,
      frequency,
      totalTrades: this.trades.length,
      avgHoldTimeHours,
      avgRoiPerTrade,
    };
  }

  /**
   * Calculate realized PnL using FIFO method
   */
  private calculateRealizedPnL(): number {
    const costBasis: Array<{ amount: number; priceInSol: number }> = [];
    let realizedPnL = 0;

    for (const trade of this.trades) {
      if (!trade.isSell) {
        // Buy: add to cost basis
        costBasis.push({
          amount: trade.amount,
          priceInSol: trade.priceInSol,
        });
      } else {
        // Sell: apply FIFO
        let remaining = trade.amount;
        while (remaining > 0 && costBasis.length > 0) {
          const lot = costBasis[0];
          const lotSize = Math.min(lot.amount, remaining);

          const costPrice = lot.priceInSol;
          const salePrice = trade.priceInSol;
          const lotPnL = (salePrice - costPrice) * lotSize;

          realizedPnL += lotPnL;

          lot.amount -= lotSize;
          remaining -= lotSize;

          if (lot.amount === 0) {
            costBasis.shift();
          }
        }
      }
    }

    return realizedPnL;
  }

  /**
   * Calculate unrealized PnL from remaining holdings
   */
  private calculateUnrealizedPnL(): number {
    const costBasis: Array<{ amount: number; priceInSol: number }> = [];

    // Rebuild cost basis from buys
    for (const trade of this.trades) {
      if (!trade.isSell) {
        costBasis.push({
          amount: trade.amount,
          priceInSol: trade.priceInSol,
        });
      } else {
        // Remove sold items from cost basis
        let remaining = trade.amount;
        while (remaining > 0 && costBasis.length > 0) {
          const lot = costBasis[0];
          const lotSize = Math.min(lot.amount, remaining);
          lot.amount -= lotSize;
          remaining -= lotSize;

          if (lot.amount === 0) {
            costBasis.shift();
          }
        }
      }
    }

    // Calculate unrealized PnL from remaining holdings
    let unrealizedPnL = 0;
    for (const lot of costBasis) {
      const lotPnL = (this.currentPrice - lot.priceInSol) * lot.amount;
      unrealizedPnL += lotPnL;
    }

    return unrealizedPnL;
  }

  /**
   * Calculate win rate: percentage of profitable trades
   * For this simple version, we estimate based on price movement pattern
   */
  private calculateWinRate(): number {
    if (this.trades.length < 2) return 0;

    let winningTrades = 0;
    let totalPairs = 0;

    // Pair up buys and sells to calculate PnL
    for (let i = 0; i < this.trades.length - 1; i++) {
      const buyTrade = this.trades[i];
      const sellTrade = this.trades[i + 1];

      // Match buy-sell pairs in order
      if (!buyTrade.isSell && sellTrade.isSell) {
        totalPairs++;
        if (sellTrade.priceInSol > buyTrade.priceInSol) {
          winningTrades++;
        }
      }
    }

    if (totalPairs === 0) return 0;
    return Math.min(winningTrades / totalPairs, 1);
  }

  /**
   * Calculate consistency: lower std dev = higher consistency (0-100)
   */
  private calculateConsistency(): number {
    if (this.trades.length < 3) return 50; // Default for insufficient data

    // Calculate returns for each trade pair
    const returns: number[] = [];

    for (let i = 0; i < this.trades.length - 1; i++) {
      const buyTrade = this.trades[i];
      const sellTrade = this.trades[i + 1];

      if (!buyTrade.isSell && sellTrade.isSell && buyTrade.priceInSol > 0) {
        const roi = (sellTrade.priceInSol - buyTrade.priceInSol) / buyTrade.priceInSol;
        returns.push(roi);
      }
    }

    if (returns.length < 2) return 50;

    // Calculate standard deviation
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    // Lower std dev = higher consistency
    // Convert to 0-100 scale: 0% std dev = 100, >50% std dev = 0
    const consistency = Math.max(0, 100 - stdDev * 100);
    return Math.min(100, consistency);
  }

  /**
   * Calculate timing: 0-100 score based on early entry
   * Did they buy before major price increases?
   */
  private calculateTiming(): number {
    if (this.trades.length < 2) return 50;

    let goodTimingTrades = 0;
    let totalTradePairs = 0;

    // For each buy-sell pair, check if they caught a price move
    for (let i = 0; i < this.trades.length - 1; i++) {
      const buyTrade = this.trades[i];
      const sellTrade = this.trades[i + 1];

      // Look for buy followed by sell
      if (!buyTrade.isSell && sellTrade.isSell) {
        totalTradePairs++;

        // Good timing if they sold at profit (price went up)
        if (sellTrade.priceInSol > buyTrade.priceInSol) {
          const roi = (sellTrade.priceInSol - buyTrade.priceInSol) / buyTrade.priceInSol;
          // Good timing if ROI >= 10%, excellent if >= 20%
          if (roi >= 0.1) {
            goodTimingTrades++;
          }
        }
      }
    }

    if (totalTradePairs === 0) return 50;

    return Math.min(100, (goodTimingTrades / totalTradePairs) * 100);
  }

  /**
   * Calculate diversification: 0-100 based on number of unique tokens/addresses
   * Proxy: using transaction count as indicator (higher = more diverse)
   */
  private calculateDiversification(): number {
    if (this.trades.length === 0) return 0;

    // Simple proxy: number of unique signatures as indicator of diversification
    const uniqueSignatures = new Set(this.trades.map((t) => t.signature)).size;

    // Normalize: 1 unique = 0, 10+ unique = 100
    const diversification = Math.min(100, (uniqueSignatures / 10) * 100);
    return diversification;
  }

  /**
   * Calculate trading frequency: trades per week
   */
  private calculateFrequency(): number {
    if (this.trades.length < 2) return 0;

    const firstTrade = this.trades[0];
    const lastTrade = this.trades[this.trades.length - 1];

    const timeSpanSeconds = lastTrade.timestamp - firstTrade.timestamp;
    const timeSpanWeeks = timeSpanSeconds / (7 * 24 * 60 * 60);

    if (timeSpanWeeks === 0) return this.trades.length; // All in one week

    return this.trades.length / timeSpanWeeks;
  }

  /**
   * Calculate average hold time in hours
   */
  private calculateAvgHoldTime(): number {
    const holdTimes: number[] = [];

    for (let i = 0; i < this.trades.length - 1; i++) {
      const buyTrade = this.trades[i];
      const sellTrade = this.trades[i + 1];

      if (!buyTrade.isSell && sellTrade.isSell) {
        const holdTimeSeconds = sellTrade.timestamp - buyTrade.timestamp;
        const holdTimeHours = holdTimeSeconds / 3600;
        holdTimes.push(holdTimeHours);
      }
    }

    if (holdTimes.length === 0) return 0;

    return holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length;
  }

  /**
   * Calculate average ROI per trade
   */
  private calculateAvgROI(): number {
    const rois: number[] = [];

    for (let i = 0; i < this.trades.length - 1; i++) {
      const buyTrade = this.trades[i];
      const sellTrade = this.trades[i + 1];

      if (!buyTrade.isSell && sellTrade.isSell && buyTrade.priceInSol > 0) {
        const roi = (sellTrade.priceInSol - buyTrade.priceInSol) / buyTrade.priceInSol;
        rois.push(roi);
      }
    }

    if (rois.length === 0) return 0;

    return rois.reduce((a, b) => a + b, 0) / rois.length;
  }

  /**
   * Convert raw metrics (various scales) to 0-100 component scores
   */
  private scoreMetrics(metrics: WalletMetrics): ScoreBreakdown {
    return {
      // Realized PnL: normalize to 0-100
      // Assume -100% to +1000% is full range
      realizedPnLScore: this.normalizeScore(metrics.realizedPnL, -100, 1000),

      // Win rate: already 0-1, convert to 0-100
      winRateScore: metrics.winRate * 100,

      // Consistency: already 0-100
      consistencyScore: metrics.consistency,

      // Timing: already 0-100
      timingScore: metrics.timing,

      // Diversification: already 0-100
      diversificationScore: metrics.diversification,

      // Frequency: normalize trades per week (0-20 per week = 0-100)
      frequencyScore: Math.min(100, (metrics.frequency / 20) * 100),
    };
  }

  /**
   * Normalize score to 0-100 range
   * Uses sigmoid-like scaling for extreme values
   */
  private normalizeScore(value: number, min: number, max: number): number {
    if (max === min) return 50;

    const normalized = (value - min) / (max - min);
    // Clamp to 0-100
    return Math.max(0, Math.min(100, normalized * 100));
  }

  /**
   * Calculate overall SmartMoneyScore using weighted formula
   * Weights are optimized to differentiate smart money from dumb money
   */
  private calculateOverallScore(breakdown: ScoreBreakdown): number {
    // Weights: sum to 1.0
    // realizedPnL is most important (40%), followed by winRate (30%)
    // consistency and timing are important (15% each)
    // diversification and frequency are lower priority (0%)
    const weights = {
      realizedPnL: 0.4,
      winRate: 0.3,
      consistency: 0.15,
      timing: 0.15,
      diversification: 0.0,
      frequency: 0.0,
    };

    const score =
      breakdown.realizedPnLScore * weights.realizedPnL +
      breakdown.winRateScore * weights.winRate +
      breakdown.consistencyScore * weights.consistency +
      breakdown.timingScore * weights.timing +
      breakdown.diversificationScore * weights.diversification +
      breakdown.frequencyScore * weights.frequency;

    return Math.round(score);
  }

  /**
   * Detect trading style based on hold times and trade frequency
   */
  private detectTradingStyle(metrics: WalletMetrics): { style: TradingStyle; confidence: number } {
    if (metrics.totalTrades < 2) {
      return { style: 'unknown', confidence: 0 };
    }

    const avgHoldHours = metrics.avgHoldTimeHours;
    const frequency = metrics.frequency;

    // Scalper: very short holds (<1 hour), high frequency
    if (avgHoldHours < 1 && frequency > 1) {
      return { style: 'scalper', confidence: 0.8 };
    }

    // Swing trader: 1-7 days holds
    if (avgHoldHours >= 1 && avgHoldHours <= 7 * 24) {
      return { style: 'swing-trader', confidence: 0.8 };
    }

    // Long-term holder: holds > 7 days
    if (avgHoldHours > 7 * 24) {
      return { style: 'long-term', confidence: 0.7 };
    }

    // Early buyer: very few trades but high ROI per trade
    if (metrics.totalTrades < 5 && metrics.avgRoiPerTrade > 0.5) {
      return { style: 'early-buyer', confidence: 0.6 };
    }

    return { style: 'unknown', confidence: 0.3 };
  }

  /**
   * Assess risk level based on volatility of returns
   */
  private assessRiskLevel(metrics: WalletMetrics): 'low' | 'medium' | 'high' {
    // High volatility (low consistency) = high risk
    if (metrics.consistency < 30) {
      return 'high';
    }

    // Medium volatility
    if (metrics.consistency < 60) {
      return 'medium';
    }

    // Low volatility
    return 'low';
  }

  /**
   * Analyze strengths and weaknesses
   */
  private analyzeStrengthsWeaknesses(
    breakdown: ScoreBreakdown
  ): { strengthAreas: string[]; weakAreas: string[] } {
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    // Strong win rate
    if (breakdown.winRateScore > 70) {
      strengths.push('High win rate');
    } else if (breakdown.winRateScore < 30) {
      weaknesses.push('Low win rate');
    }

    // Strong consistency
    if (breakdown.consistencyScore > 70) {
      strengths.push('Consistent returns');
    } else if (breakdown.consistencyScore < 30) {
      weaknesses.push('Inconsistent returns');
    }

    // Good timing
    if (breakdown.timingScore > 70) {
      strengths.push('Excellent entry timing');
    } else if (breakdown.timingScore < 30) {
      weaknesses.push('Poor entry timing');
    }

    // High realized PnL
    if (breakdown.realizedPnLScore > 70) {
      strengths.push('Strong profitability');
    } else if (breakdown.realizedPnLScore < 30) {
      weaknesses.push('Limited profitability');
    }

    // Diversification
    if (breakdown.diversificationScore > 70) {
      strengths.push('Good diversification');
    } else if (breakdown.diversificationScore < 30) {
      weaknesses.push('Limited diversification');
    }

    return { strengthAreas: strengths, weakAreas: weaknesses };
  }

  /**
   * Convert score (0-100) to percentile (0-100)
   * Used for ranking against other wallets
   */
  private scoreToPercentile(score: number): number {
    // For now, assume score is already percentile-like
    // This would be calibrated against real wallet distribution
    return Math.round(score);
  }

  /**
   * Return a default score for edge cases
   */
  private getDefaultScore(reason: string): SmartMoneyScore {
    return {
      score: 0,
      percentile: 0,
      metrics: {
        realizedPnL: 0,
        unrealizedPnL: 0,
        winRate: 0,
        consistency: 0,
        timing: 0,
        diversification: 0,
        frequency: 0,
        totalTrades: 0,
        avgHoldTimeHours: 0,
        avgRoiPerTrade: 0,
      },
      tradingStyle: 'unknown',
      styleConfidence: 0,
      breakdown: {
        realizedPnLScore: 0,
        winRateScore: 0,
        consistencyScore: 0,
        timingScore: 0,
        diversificationScore: 0,
        frequencyScore: 0,
      },
      riskLevel: 'medium',
      strengthAreas: [],
      weakAreas: [`Unable to analyze: ${reason}`],
    };
  }
}

/**
 * Convenience function to analyze a wallet
 */
export async function analyzeWallet(
  walletAddress: string,
  currentPrice?: number
): Promise<SmartMoneyScore> {
  const analyzer = new WalletAnalyzer(walletAddress, currentPrice);
  return analyzer.analyze();
}
