/**
 * PER-COIN TRADER ANALYSIS
 *
 * The core smart-money discovery method, made explicit: take one coin, pull
 * EVERY wallet that bought or sold it, and rank them by realized PnL on that
 * coin. The consistent winners across many coins are the smart money.
 *
 * Uses the same Helius swap parser (full, paginated history) and the same
 * cost-basis PnL engine the leaderboard uses, so a wallet's per-coin number
 * here is consistent with its aggregate score.
 */

import { fetchAllWalletTradesForToken } from './swap-fetcher';
import type { Trade } from '../pnl-engine';

export interface TokenTrader {
  wallet: string;
  realizedPnl: number; // SOL realized on this coin (cost-basis)
  unrealizedPnl: number; // SOL paper PnL on tokens still held (marked at latest price)
  totalPnl: number; // realized + unrealized
  roi: number; // realizedPnl / SOL spent buying (0..)
  solSpent: number; // total SOL paid across buys
  solReceived: number; // total SOL received across sells
  buys: number;
  sells: number;
  tokensBought: number;
  tokensSold: number;
  tokensRemaining: number; // still held (unrealized exposure)
  firstTradeAt: string | null;
  lastTradeAt: string | null;
}

export interface TokenTradersResult {
  mint: string;
  txScanned: number; // wallet-attributed swaps parsed
  traderCount: number;
  markPrice: number; // SOL/token used to value remaining holdings (latest trade)
  traders: TokenTrader[];
}

function summarize(wallet: string, trades: Trade[], mint: string, markPrice: number): TokenTrader {
  let solSpent = 0;
  let solReceived = 0;
  let buys = 0;
  let sells = 0;
  let tokensBought = 0;
  let tokensSold = 0;
  let first: Date | null = null;
  let last: Date | null = null;

  for (const t of trades) {
    const sol = t.amount * t.pricePerToken;
    if (t.tradeType === 'BUY') {
      solSpent += sol;
      tokensBought += t.amount;
      buys += 1;
    } else {
      solReceived += sol;
      tokensSold += t.amount;
      sells += 1;
    }
    if (!first || t.date < first) first = t.date;
    if (!last || t.date > last) last = t.date;
  }

  // Average-cost PnL: realized on tokens sold, plus unrealized on tokens still
  // held marked at the coin's latest observed price. Self-consistent so that
  // total = SOL out of sells + current bag value − SOL into buys.
  const avgCost = tokensBought > 0 ? solSpent / tokensBought : 0;
  const tokensRemaining = Math.max(0, tokensBought - tokensSold);
  const realizedPnl = solReceived - tokensSold * avgCost;
  const unrealizedPnl = tokensRemaining * (markPrice - avgCost);

  const r4 = (n: number) => Math.round(n * 10000) / 10000;

  return {
    wallet,
    realizedPnl: r4(realizedPnl),
    unrealizedPnl: r4(unrealizedPnl),
    totalPnl: r4(realizedPnl + unrealizedPnl),
    roi: solSpent > 0 ? r4(realizedPnl / solSpent) : 0,
    solSpent: r4(solSpent),
    solReceived: r4(solReceived),
    buys,
    sells,
    tokensBought,
    tokensSold,
    tokensRemaining,
    firstTradeAt: first ? first.toISOString() : null,
    lastTradeAt: last ? last.toISOString() : null,
  };
}

/**
 * Analyze a coin: fetch its full swap history, group by wallet, and rank wallets
 * by realized PnL on that coin (descending).
 */
export async function analyzeTokenTraders(
  mint: string,
  maxTxs = 600
): Promise<TokenTradersResult> {
  const walletTrades = await fetchAllWalletTradesForToken(mint, maxTxs);

  // Mark price = the coin's most recently observed trade price, used to value
  // tokens wallets are still holding.
  let markPrice = 0;
  let markAt = -Infinity;
  const byWallet = new Map<string, Trade[]>();
  for (const { wallet, trade } of walletTrades) {
    const list = byWallet.get(wallet);
    if (list) list.push(trade);
    else byWallet.set(wallet, [trade]);
    const t = trade.date.getTime();
    if (t > markAt) {
      markAt = t;
      markPrice = trade.pricePerToken;
    }
  }

  const traders: TokenTrader[] = [];
  for (const [wallet, trades] of byWallet) {
    traders.push(summarize(wallet, trades, mint, markPrice));
  }

  traders.sort((a, b) => b.totalPnl - a.totalPnl);

  return {
    mint,
    txScanned: walletTrades.length,
    traderCount: traders.length,
    markPrice,
    traders,
  };
}
