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
import { TradeProcessor, type Trade } from '../pnl-engine';

export interface TokenTrader {
  wallet: string;
  realizedPnl: number; // SOL realized on this coin (cost-basis)
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
  traders: TokenTrader[];
}

function summarize(wallet: string, trades: Trade[], mint: string): TokenTrader {
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

  // Cost-basis realized PnL from the shared engine (handles partial sells).
  const processor = new TradeProcessor();
  processor.addTrades(trades);
  const summary = processor.calculatePnL().byToken.get(mint);
  const realizedPnl = summary ? summary.realizedPnL : solReceived - solSpent;

  return {
    wallet,
    realizedPnl: Math.round(realizedPnl * 10000) / 10000,
    roi: solSpent > 0 ? Math.round((realizedPnl / solSpent) * 10000) / 10000 : 0,
    solSpent: Math.round(solSpent * 10000) / 10000,
    solReceived: Math.round(solReceived * 10000) / 10000,
    buys,
    sells,
    tokensBought,
    tokensSold,
    tokensRemaining: Math.max(0, tokensBought - tokensSold),
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

  const byWallet = new Map<string, Trade[]>();
  for (const { wallet, trade } of walletTrades) {
    const list = byWallet.get(wallet);
    if (list) list.push(trade);
    else byWallet.set(wallet, [trade]);
  }

  const traders: TokenTrader[] = [];
  for (const [wallet, trades] of byWallet) {
    traders.push(summarize(wallet, trades, mint));
  }

  traders.sort((a, b) => b.realizedPnl - a.realizedPnl);

  return {
    mint,
    txScanned: walletTrades.length,
    traderCount: traders.length,
    traders,
  };
}
