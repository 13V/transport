import { computeAccuratePnL } from '../indexer/accurate-pnl';
import type { Trade } from '../pnl-engine';

// Helper to build a Trade with sane defaults. `t` is a second offset used to
// order trades chronologically.
function trade(
  tokenMint: string,
  tradeType: 'BUY' | 'SELL',
  amount: number,
  pricePerToken: number,
  t = 0
): Trade {
  return {
    tokenMint,
    tradeType,
    amount,
    pricePerToken,
    date: new Date(1_700_000_000_000 + t * 1000),
    txHash: `${tokenMint}-${tradeType}-${t}`,
    source: 'RAYDIUM',
  };
}

const MINT_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MINT_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

describe('computeAccuratePnL', () => {
  it('winner: roiPct = profit / costOfSold * 100', () => {
    // Buy 10 @ 1 SOL (cost 10), sell 10 @ 2 SOL (proceeds 20). profit = 10.
    const trades = [
      trade(MINT_A, 'BUY', 10, 1, 0),
      trade(MINT_A, 'SELL', 10, 2, 1),
    ];
    const r = computeAccuratePnL(trades);

    expect(r.realizedPnlSol).toBe(10);
    expect(r.investedSol).toBe(10); // cost of sold quantity
    expect(r.roiPct).toBe(100); // 10 / 10 * 100
    expect(r.winRate).toBe(1);
    expect(r.consistency).toBe(1);
    expect(r.tokensTraded).toBe(1);
    expect(r.totalTrades).toBe(2);
    expect(r.unmatchedSoldSol).toBe(0);
    expect(r.remainingCostSol).toBe(0);
  });

  it('FIFO two lots: oldest lot consumed first', () => {
    // Lot1: 10 @ 1 (cost 10). Lot2: 10 @ 3 (cost 30). Sell 15 @ 4.
    // FIFO: 10 from lot1 (cost 10) + 5 from lot2 (cost 15) => matchedCost 25.
    // proceeds = 15 * 4 = 60. realized = 60 - 25 = 35.
    // remaining: 5 @ 3 = 15 cost held.
    const trades = [
      trade(MINT_A, 'BUY', 10, 1, 0),
      trade(MINT_A, 'BUY', 10, 3, 1),
      trade(MINT_A, 'SELL', 15, 4, 2),
    ];
    const r = computeAccuratePnL(trades);

    expect(r.investedSol).toBe(25);
    expect(r.realizedPnlSol).toBe(35);
    expect(r.roiPct).toBe(140); // 35 / 25 * 100
    expect(r.remainingCostSol).toBe(15);
    // Two FIFO matches → two realized events.
    expect(r.realizedEvents).toBe(2);
    expect(r.winRate).toBe(1); // both matched events gained
  });

  it('partial sell: only sold quantity counted, rest stays as cost', () => {
    // Buy 10 @ 2 (cost 20). Sell 4 @ 5 => matchedCost = 8, proceeds 20, realized 12.
    // remaining 6 @ 2 = 12 cost held.
    const trades = [
      trade(MINT_A, 'BUY', 10, 2, 0),
      trade(MINT_A, 'SELL', 4, 5, 1),
    ];
    const r = computeAccuratePnL(trades);

    expect(r.investedSol).toBe(8);
    expect(r.realizedPnlSol).toBe(12);
    expect(r.roiPct).toBe(150); // 12 / 8 * 100
    expect(r.remainingCostSol).toBe(12);
  });

  it('phantom seller: a sell with no prior buy realizes 0 and records unmatched proceeds', () => {
    // Sell 5 @ 2 with no buy. No cost basis → realized 0, unmatched proceeds = 10.
    const trades = [trade(MINT_A, 'SELL', 5, 2, 0)];
    const r = computeAccuratePnL(trades);

    expect(r.realizedPnlSol).toBe(0);
    expect(r.investedSol).toBe(0);
    expect(r.roiPct).toBe(0); // matchedCost 0 → guarded division
    expect(r.unmatchedSoldSol).toBe(10);
    expect(r.realizedEvents).toBe(0);
    expect(r.closedTokens).toBe(0);
    expect(r.winRate).toBe(0);
  });

  it('re-buy after full sell: lots reset, FIFO restarts on new lot', () => {
    // Buy 10 @ 1, sell 10 @ 2 (profit 10, matchedCost 10).
    // Re-buy 10 @ 5, sell 10 @ 6 (profit 10, matchedCost 50).
    // total realized 20, matchedCost 60.
    const trades = [
      trade(MINT_A, 'BUY', 10, 1, 0),
      trade(MINT_A, 'SELL', 10, 2, 1),
      trade(MINT_A, 'BUY', 10, 5, 2),
      trade(MINT_A, 'SELL', 10, 6, 3),
    ];
    const r = computeAccuratePnL(trades);

    expect(r.realizedPnlSol).toBe(20);
    expect(r.investedSol).toBe(60);
    expect(r.roiPct).toBeCloseTo((20 / 60) * 100, 4); // ~33.3333
    expect(r.remainingCostSol).toBe(0);
    expect(r.realizedEvents).toBe(2);
  });

  it('multi-token consistency = 0.5 when one of two closed tokens is net-positive', () => {
    // Token A: net win. Token B: net loss. Both closed (have realized events).
    const trades = [
      // A: buy 10 @ 1, sell 10 @ 2 → +10
      trade(MINT_A, 'BUY', 10, 1, 0),
      trade(MINT_A, 'SELL', 10, 2, 1),
      // B: buy 10 @ 2, sell 10 @ 1 → -10
      trade(MINT_B, 'BUY', 10, 2, 2),
      trade(MINT_B, 'SELL', 10, 1, 3),
    ];
    const r = computeAccuratePnL(trades);

    expect(r.closedTokens).toBe(2);
    expect(r.profitableTokens).toBe(1);
    expect(r.consistency).toBe(0.5);
    expect(r.realizedPnlSol).toBe(0); // +10 and -10 net out
    expect(r.tokensTraded).toBe(2);
    expect(r.winRate).toBe(0.5); // one win event, one loss event
  });

  it('no-sells (only buys): no division by zero, roiPct = 0', () => {
    const trades = [
      trade(MINT_A, 'BUY', 10, 1, 0),
      trade(MINT_C, 'BUY', 5, 4, 1),
    ];
    const r = computeAccuratePnL(trades);

    expect(r.realizedPnlSol).toBe(0);
    expect(r.investedSol).toBe(0);
    expect(r.roiPct).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.consistency).toBe(0);
    expect(r.closedTokens).toBe(0);
    expect(r.remainingCostSol).toBe(30); // 10*1 + 5*4
    expect(r.tokensTraded).toBe(2);
  });
});
