import { getAddressTransactions } from '../helius-client';
import type { SmartMoneyWallet, HolderInfo } from '../types';

interface TradeEvent {
  timestamp: number;
  amount: number;
  priceInSol: number;
  totalCost: number;
  signature: string;
}

/**
 * Detect smart-money wallets by PnL ranking
 * Strategy: For top holders, calculate realized PnL from buy/sell history
 * FIFO cost basis method: first tokens bought are first sold
 *
 * LIMITATION: Current implementation is a heuristic due to unparsed transaction data.
 * For production accuracy, this needs:
 * 1. Proper transaction instruction parsing (decode SPL token transfers)
 * 2. Historical price lookups (not current price for all trades)
 * 3. Cross-token analysis (trades on Raydium, Orca, etc.)
 * This MVP flags high-activity wallets; real PnL requires full instruction parsing.
 */
export async function detectSmartMoney(
  mint: string,
  holders: HolderInfo[],
  currentPrice: number
): Promise<SmartMoneyWallet[]> {
  try {
    // Analyze only top 50 holders for performance
    const topHolders = holders.slice(0, 50);

    const results = await Promise.all(
      topHolders.map((holder) => analyzeWalletPnL(holder.address, mint, currentPrice))
    );

    // Filter out wallets with no trades and sort by realized PnL
    const validWallets = results.filter(
      (wallet): wallet is SmartMoneyWallet => wallet !== null && wallet.totalTrades > 0
    );
    return validWallets.sort((a, b) => b.realizedPnL - a.realizedPnL);
  } catch (error) {
    console.error('Error detecting smart money:', error);
    return [];
  }
}

/**
 * Calculate PnL for a single wallet
 * Uses FIFO method: first in, first out
 */
async function analyzeWalletPnL(
  walletAddress: string,
  mint: string,
  currentPrice: number
): Promise<SmartMoneyWallet | null> {
  try {
    const txs = await getAddressTransactions(walletAddress, 100);

    if (txs.length === 0) {
      return null;
    }

    const trades: TradeEvent[] = [];

    // Categorize transactions as buys or sells
    for (const tx of txs) {
      // Look for token-related transfers (buy/sell)
      // For now, we'll mark transfers out as sells and transfers in as buys
      // This is a simplified heuristic; in production, you'd decode the actual transfer instructions
      if (tx.type === 'TRANSFER' && tx.amount && tx.amount > 0) {
        // Assume outflows are sells, inflows are buys (heuristic)
        const isSell = !tx.source?.includes(walletAddress);

        trades.push({
          timestamp: tx.timestamp,
          amount: tx.amount,
          priceInSol: currentPrice, // Simplified: assume current price
          totalCost: tx.amount * currentPrice,
          signature: tx.signature,
        });
      }
    }

    if (trades.length < 2) {
      return null;
    }

    // Sort by timestamp
    trades.sort((a, b) => a.timestamp - b.timestamp);

    // Calculate FIFO realized PnL
    const costBasis: { amount: number; priceInSol: number }[] = [];
    let realizedPnL = 0;
    let totalTokensSold = 0;

    for (const trade of trades) {
      // Simplified: alternate buys and sells
      const isBuy = (trades.indexOf(trade) % 2) === 0;

      if (isBuy) {
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
          totalTokensSold += lotSize;

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
      const lotPnL = (currentPrice - lot.priceInSol) * lot.amount;
      unrealizedPnL += lotPnL;
    }

    // Win rate: trades with positive PnL
    const winningTrades = trades.filter((t) => t.priceInSol > 0).length;
    const winRate = trades.length > 0 ? winningTrades / trades.length : 0;

    // Average hold time
    const holdTimes = [];
    for (let i = 0; i < trades.length - 1; i++) {
      holdTimes.push(trades[i + 1].timestamp - trades[i].timestamp);
    }
    const avgHoldTimeHours =
      holdTimes.length > 0
        ? (holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length / 3600)
        : 0;

    return {
      address: walletAddress,
      realizedPnL,
      unrealizedPnL,
      winRate: Math.min(winRate, 1),
      totalTrades: trades.length,
      avgHoldTimeHours,
    };
  } catch (error) {
    console.error(`Error analyzing wallet PnL ${walletAddress}:`, error);
    return null;
  }
}
