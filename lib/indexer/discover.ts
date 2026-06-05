/**
 * ON-DEMAND SMART-WALLET DISCOVERY (no cron, no DB)
 *
 * Scans a batch of currently-active coins live, runs the per-coin trader PnL
 * analysis on each, and aggregates every wallet's results ACROSS those coins.
 * The wallets that win repeatedly are the smart money.
 *
 * This is the "give me the list right now" path — it needs only HELIUS_API_KEY,
 * touches no database, and reflects the present moment rather than accumulated
 * history. Bounded by a time budget to fit the serverless limit.
 */

import { getTokenUniverse } from './token-universe';
import { analyzeTokenTraders } from './token-traders';

export interface DiscoveredWallet {
  wallet: string;
  realizedPnl: number; // summed realized PnL across scanned coins (SOL)
  unrealizedPnl: number; // summed unrealized (held bags marked at latest price)
  totalPnl: number; // realized + unrealized
  coinsTraded: number; // distinct scanned coins this wallet traded
  coinsWon: number; // of those, how many ended net-positive realized
  buys: number;
  sells: number;
}

export interface DiscoverResult {
  coinsScanned: number;
  walletCount: number;
  elapsedMs: number;
  wallets: DiscoveredWallet[];
}

export interface DiscoverOptions {
  maxCoins?: number;
  maxTxsPerCoin?: number;
  timeBudgetMs?: number;
}

export async function discoverSmartWallets(opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const start = Date.now();
  const maxCoins = opts.maxCoins ?? 12;
  const maxTxsPerCoin = opts.maxTxsPerCoin ?? 500;
  const timeBudgetMs = opts.timeBudgetMs ?? 50_000;

  const tokens = await getTokenUniverse(maxCoins);
  const agg = new Map<string, DiscoveredWallet>();
  let coinsScanned = 0;

  for (const token of tokens) {
    if (Date.now() - start > timeBudgetMs) break;

    let traders;
    try {
      traders = (await analyzeTokenTraders(token.mint, maxTxsPerCoin)).traders;
    } catch (err) {
      // One bad coin shouldn't sink the whole scan (e.g. an auth blip).
      console.error(`[DISCOVER] ${token.mint} failed:`, (err as Error).message);
      continue;
    }
    coinsScanned += 1;

    for (const t of traders) {
      const cur =
        agg.get(t.wallet) ??
        {
          wallet: t.wallet,
          realizedPnl: 0,
          unrealizedPnl: 0,
          totalPnl: 0,
          coinsTraded: 0,
          coinsWon: 0,
          buys: 0,
          sells: 0,
        };
      cur.realizedPnl += t.realizedPnl;
      cur.unrealizedPnl += t.unrealizedPnl;
      cur.totalPnl += t.totalPnl;
      cur.coinsTraded += 1;
      if (t.realizedPnl > 0) cur.coinsWon += 1;
      cur.buys += t.buys;
      cur.sells += t.sells;
      agg.set(t.wallet, cur);
    }
  }

  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  const wallets = [...agg.values()]
    .map((w) => ({
      ...w,
      realizedPnl: r4(w.realizedPnl),
      unrealizedPnl: r4(w.unrealizedPnl),
      totalPnl: r4(w.totalPnl),
    }))
    .sort((a, b) => b.realizedPnl - a.realizedPnl);

  return {
    coinsScanned,
    walletCount: wallets.length,
    elapsedMs: Date.now() - start,
    wallets,
  };
}
