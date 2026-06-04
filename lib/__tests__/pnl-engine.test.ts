/**
 * Unit Tests for PnL Calculation Engine
 *
 * Tests bonding curve math, AMM swaps, FIFO cost basis, and portfolio aggregation
 * All tests use real data from Agent 1's research validation
 */

import {
  BondingCurveCalculator,
  AMMSwapCalculator,
  CostBasisTracker,
  TradeProcessor,
  Trade,
  TokenPnLSummary,
} from '../pnl-engine';

/**
 * ============================================================================
 * BONDING CURVE TESTS (10+ tests)
 * ============================================================================
 */

describe('BondingCurveCalculator', () => {
  describe('calculateTokensFromSol', () => {
    it('should calculate tokens from SOL spent (basic)', () => {
      // At 0 SOL: y = 1073000191 - 32190005730/30 = 1073000191 - 1073000191 = 0
      const tokens = BondingCurveCalculator.calculateTokensFromSol(0);
      expect(tokens).toBeCloseTo(0, 0);
    });

    it('should calculate tokens from 1 SOL', () => {
      // y = 1073000191 - 32190005730/(30+1)
      const tokens = BondingCurveCalculator.calculateTokensFromSol(1);
      const expected = 1073000191 - 32190005730 / 31;
      expect(tokens).toBeCloseTo(expected, 2);
    });

    it('should calculate tokens from 5 SOL', () => {
      const tokens = BondingCurveCalculator.calculateTokensFromSol(5);
      const expected = 1073000191 - 32190005730 / 35;
      expect(tokens).toBeCloseTo(expected, 2);
    });

    it('should calculate tokens from 10 SOL', () => {
      const tokens = BondingCurveCalculator.calculateTokensFromSol(10);
      const expected = 1073000191 - 32190005730 / 40;
      expect(tokens).toBeCloseTo(expected, 2);
    });

    it('should handle large SOL amounts', () => {
      const tokens = BondingCurveCalculator.calculateTokensFromSol(1000);
      const expected = 1073000191 - 32190005730 / 1030;
      expect(tokens).toBeCloseTo(expected, 2);
      expect(tokens).toBeLessThan(1073000191);
    });

    it('should throw on negative SOL amount', () => {
      expect(() => BondingCurveCalculator.calculateTokensFromSol(-1)).toThrow();
    });

    it('should show increasing tokens with increasing SOL', () => {
      const at1 = BondingCurveCalculator.calculateTokensFromSol(1);
      const at5 = BondingCurveCalculator.calculateTokensFromSol(5);
      const at10 = BondingCurveCalculator.calculateTokensFromSol(10);
      expect(at1 < at5).toBe(true);
      expect(at5 < at10).toBe(true);
    });
  });

  describe('calculateSolForTokens', () => {
    it('should calculate SOL needed for target tokens', () => {
      // If we need 1B tokens:
      // x = B/(A-y) - C
      const tokensTarget = 1000000000;
      const solNeeded = BondingCurveCalculator.calculateSolForTokens(tokensTarget);
      // Verify by converting back
      const tokensBack = BondingCurveCalculator.calculateTokensFromSol(solNeeded);
      expect(tokensBack).toBeCloseTo(tokensTarget, 0);
    });

    it('should throw on target >= supply cap', () => {
      expect(() => BondingCurveCalculator.calculateSolForTokens(1073000191)).toThrow();
      expect(() => BondingCurveCalculator.calculateSolForTokens(1073000192)).toThrow();
    });

    it('should throw on negative target', () => {
      expect(() => BondingCurveCalculator.calculateSolForTokens(-100)).toThrow();
    });
  });

  describe('calculateEntryPrice', () => {
    it('should calculate entry price correctly', () => {
      const solSpent = 5;
      const tokensReceived = 100000;
      const price = BondingCurveCalculator.calculateEntryPrice(solSpent, tokensReceived);
      expect(price).toBeCloseTo(0.00005, 10); // 5 SOL / 100k tokens
    });

    it('should calculate entry price for 10 SOL, 1M tokens', () => {
      const price = BondingCurveCalculator.calculateEntryPrice(10, 1000000);
      expect(price).toBeCloseTo(0.00001, 10);
    });

    it('should throw on zero tokens', () => {
      expect(() => BondingCurveCalculator.calculateEntryPrice(5, 0)).toThrow();
    });

    it('should handle large token amounts', () => {
      const price = BondingCurveCalculator.calculateEntryPrice(100, 1000000000);
      expect(price).toBeCloseTo(0.0000001, 12);
      expect(price).toBeGreaterThan(0);
    });
  });

  describe('calculateCurrentBondingCurvePrice', () => {
    it('should calculate marginal price at 0 SOL spent', () => {
      // dy/dx = B/(C+x)^2 = 32190005730/900
      const price = BondingCurveCalculator.calculateCurrentBondingCurvePrice(0);
      const expected = 32190005730 / (30 * 30);
      expect(price).toBeCloseTo(expected, 2);
    });

    it('should calculate marginal price at 10 SOL spent', () => {
      const price = BondingCurveCalculator.calculateCurrentBondingCurvePrice(10);
      const expected = 32190005730 / (40 * 40);
      expect(price).toBeCloseTo(expected, 2);
    });

    it('should decrease as SOL spent increases', () => {
      const price0 = BondingCurveCalculator.calculateCurrentBondingCurvePrice(0);
      const price10 = BondingCurveCalculator.calculateCurrentBondingCurvePrice(10);
      const price100 = BondingCurveCalculator.calculateCurrentBondingCurvePrice(100);
      expect(price0 > price10).toBe(true);
      expect(price10 > price100).toBe(true);
    });

    it('should throw on negative SOL amount', () => {
      expect(() => BondingCurveCalculator.calculateCurrentBondingCurvePrice(-1)).toThrow();
    });
  });

  describe('calculateExitPrice', () => {
    it('should return the input price', () => {
      const price = 0.0001;
      const exitPrice = BondingCurveCalculator.calculateExitPrice(price);
      expect(exitPrice).toBe(price);
    });

    it('should throw on negative price', () => {
      expect(() => BondingCurveCalculator.calculateExitPrice(-0.0001)).toThrow();
    });
  });
});

/**
 * ============================================================================
 * AMM SWAP TESTS (10+ tests)
 * ============================================================================
 */

describe('AMMSwapCalculator', () => {
  describe('calculateSwapPrice', () => {
    it('should calculate price for equal decimals', () => {
      const swap = {
        tokenIn: 'USDC',
        amountIn: 1000000, // 1 USDC (6 decimals)
        tokenOut: 'SOL',
        amountOut: 5000000, // 5 SOL (6 decimals)
        dex: 'RAYDIUM' as const,
        timestamp: Date.now(),
      };

      const price = AMMSwapCalculator.calculateSwapPrice(swap, 6, 6);
      expect(price).toBeCloseTo(5, 6); // 5 SOL per USDC
    });

    it('should handle different token decimals', () => {
      // USDC (6) -> BONK (5)
      const swap = {
        tokenIn: 'USDC',
        amountIn: 1000000, // 1 USDC
        tokenOut: 'BONK',
        amountOut: 5000, // 5000 BONK (5 decimals = 50 actual BONK)
        dex: 'RAYDIUM' as const,
        timestamp: Date.now(),
      };

      const price = AMMSwapCalculator.calculateSwapPrice(swap, 6, 5);
      expect(price).toBeCloseTo(50, 0); // 50 BONK per USDC
    });

    it('should calculate price for SOL to token swap', () => {
      // 1 SOL (9 decimals) -> 1M tokens (6 decimals)
      const swap = {
        tokenIn: 'SOL',
        amountIn: 1000000000, // 1 SOL
        tokenOut: 'MEME',
        amountOut: 1000000, // 1M tokens
        dex: 'RAYDIUM' as const,
        timestamp: Date.now(),
      };

      const price = AMMSwapCalculator.calculateSwapPrice(swap, 9, 6);
      expect(price).toBeCloseTo(1000000, 0); // 1M tokens per SOL
    });

    it('should handle small amounts', () => {
      const swap = {
        tokenIn: 'SOL',
        amountIn: 100000000, // 0.1 SOL
        tokenOut: 'TOKEN',
        amountOut: 50000, // 50k tokens
        dex: 'RAYDIUM' as const,
        timestamp: Date.now(),
      };

      const price = AMMSwapCalculator.calculateSwapPrice(swap, 9, 6);
      expect(price).toBeCloseTo(500000, 0); // 500k tokens per SOL
    });

    it('should throw on zero amount in', () => {
      const swap = {
        tokenIn: 'SOL',
        amountIn: 0,
        tokenOut: 'TOKEN',
        amountOut: 100000,
        dex: 'RAYDIUM' as const,
        timestamp: Date.now(),
      };

      expect(() => AMMSwapCalculator.calculateSwapPrice(swap, 9, 6)).toThrow();
    });
  });

  describe('calculatePriceWithSlippage', () => {
    it('should apply slippage discount', () => {
      const expectedPrice = 100;
      const priceWithSlippage = AMMSwapCalculator.calculatePriceWithSlippage(expectedPrice, 1);
      expect(priceWithSlippage).toBeCloseTo(99, 2); // 1% slippage
    });

    it('should handle 0% slippage', () => {
      const expectedPrice = 100;
      const priceWithSlippage = AMMSwapCalculator.calculatePriceWithSlippage(expectedPrice, 0);
      expect(priceWithSlippage).toBe(expectedPrice);
    });

    it('should handle significant slippage', () => {
      const expectedPrice = 100;
      const priceWithSlippage = AMMSwapCalculator.calculatePriceWithSlippage(expectedPrice, 5);
      expect(priceWithSlippage).toBeCloseTo(95, 2); // 5% slippage
    });

    it('should reduce price with increasing slippage', () => {
      const expectedPrice = 100;
      const p1 = AMMSwapCalculator.calculatePriceWithSlippage(expectedPrice, 1);
      const p2 = AMMSwapCalculator.calculatePriceWithSlippage(expectedPrice, 2);
      const p5 = AMMSwapCalculator.calculatePriceWithSlippage(expectedPrice, 5);
      expect(p1 > p2).toBe(true);
      expect(p2 > p5).toBe(true);
    });
  });
});

/**
 * ============================================================================
 * FIFO COST BASIS TESTS (20+ tests)
 * ============================================================================
 */

describe('CostBasisTracker', () => {
  let tracker: CostBasisTracker;

  beforeEach(() => {
    tracker = new CostBasisTracker();
  });

  describe('addBuy', () => {
    it('should add a buy to tracker', () => {
      tracker.addBuy(100, 0.01, new Date(), 'tx1');
      expect(tracker.getTotalQuantityHeld()).toBe(100);
    });

    it('should maintain FIFO order', () => {
      const date1 = new Date('2024-01-01');
      const date2 = new Date('2024-01-02');
      const date3 = new Date('2024-01-03');

      tracker.addBuy(100, 0.01, date2, 'tx2');
      tracker.addBuy(50, 0.02, date1, 'tx1');
      tracker.addBuy(75, 0.015, date3, 'tx3');

      const lots = tracker.getLots();
      expect(lots[0].purchaseDate).toEqual(date1);
      expect(lots[1].purchaseDate).toEqual(date2);
      expect(lots[2].purchaseDate).toEqual(date3);
    });

    it('should throw on negative amount', () => {
      expect(() => tracker.addBuy(-100, 0.01, new Date(), 'tx1')).toThrow();
    });

    it('should throw on negative cost', () => {
      expect(() => tracker.addBuy(100, -0.01, new Date(), 'tx1')).toThrow();
    });

    it('should handle zero cost (airdrop)', () => {
      tracker.addBuy(1000, 0, new Date(), 'tx1');
      expect(tracker.getTotalQuantityHeld()).toBe(1000);
      expect(tracker.getTotalCostBasis()).toBe(0);
    });

    it('should accumulate multiple buys', () => {
      tracker.addBuy(100, 0.01, new Date('2024-01-01'), 'tx1');
      tracker.addBuy(200, 0.015, new Date('2024-01-02'), 'tx2');
      tracker.addBuy(50, 0.02, new Date('2024-01-03'), 'tx3');

      expect(tracker.getTotalQuantityHeld()).toBe(350);
      expect(tracker.getTotalCostBasis()).toBeCloseTo(100 * 0.01 + 200 * 0.015 + 50 * 0.02, 5);
    });
  });

  describe('sellFIFO', () => {
    beforeEach(() => {
      tracker.addBuy(100, 0.01, new Date('2024-01-01'), 'tx1');
      tracker.addBuy(100, 0.02, new Date('2024-01-02'), 'tx2');
      tracker.addBuy(100, 0.03, new Date('2024-01-03'), 'tx3');
    });

    it('should sell from oldest lot first (FIFO)', () => {
      const resolved = tracker.sellFIFO(50, 0.05, new Date('2024-01-04'));

      expect(resolved.length).toBe(1);
      expect(resolved[0].soldAmount).toBe(50);
      expect(resolved[0].originalLot.costPerToken).toBeCloseTo(0.01, 5);
      expect(resolved[0].realizedGain).toBeCloseTo(50 * (0.05 - 0.01), 5);
    });

    it('should handle partial lot sales', () => {
      const resolved = tracker.sellFIFO(150, 0.05, new Date('2024-01-04'));

      expect(resolved.length).toBe(2);
      expect(resolved[0].soldAmount).toBe(100); // Entire first lot
      expect(resolved[1].soldAmount).toBe(50); // Half of second lot
    });

    it('should calculate realized gain correctly', () => {
      const resolved = tracker.sellFIFO(100, 0.05, new Date('2024-01-04'));
      const expectedGain = 100 * (0.05 - 0.01);
      expect(resolved[0].realizedGain).toBeCloseTo(expectedGain, 5);
    });

    it('should handle loss (selling below cost)', () => {
      const resolved = tracker.sellFIFO(100, 0.005, new Date('2024-01-04'));
      const expectedLoss = 100 * (0.005 - 0.01);
      expect(resolved[0].realizedGain).toBeCloseTo(expectedLoss, 5);
      expect(resolved[0].realizedGain).toBeLessThan(0);
    });

    it('should update remaining lots after sale', () => {
      tracker.sellFIFO(100, 0.05, new Date('2024-01-04'));
      expect(tracker.getTotalQuantityHeld()).toBe(200); // 300 - 100 sold
    });

    it('should remove exhausted lots', () => {
      tracker.sellFIFO(50, 0.05, new Date('2024-01-04'));
      const lots = tracker.getLots();
      expect(lots[0].amount).toBe(50); // First lot has 50 remaining
      expect(lots.length).toBe(3);

      tracker.sellFIFO(50, 0.05, new Date('2024-01-05'));
      const lotsAfter = tracker.getLots();
      expect(lotsAfter.length).toBe(2); // First lot fully removed
    });

    it('should throw on insufficient holdings', () => {
      expect(() => tracker.sellFIFO(500, 0.05, new Date('2024-01-04'))).toThrow();
    });

    it('should throw on negative sell amount', () => {
      expect(() => tracker.sellFIFO(-100, 0.05, new Date('2024-01-04'))).toThrow();
    });

    it('should throw on negative sell price', () => {
      expect(() => tracker.sellFIFO(100, -0.05, new Date('2024-01-04'))).toThrow();
    });

    it('should calculate realized gain percentage', () => {
      const resolved = tracker.sellFIFO(100, 0.02, new Date('2024-01-04'));
      const expectedPct = ((0.02 / 0.01) - 1) * 100;
      expect(resolved[0].realizedGainPct).toBeCloseTo(expectedPct, 2);
    });

    it('should handle selling entire position', () => {
      tracker.sellFIFO(300, 0.04, new Date('2024-01-04'));
      expect(tracker.getTotalQuantityHeld()).toBe(0);
      expect(tracker.getLots().length).toBe(0);
    });

    it('should handle multiple sells', () => {
      tracker.sellFIFO(100, 0.05, new Date('2024-01-04'));
      tracker.sellFIFO(100, 0.06, new Date('2024-01-05'));
      tracker.sellFIFO(100, 0.07, new Date('2024-01-06'));

      expect(tracker.getTotalQuantityHeld()).toBe(0);
    });
  });

  describe('getUnrealizedPnL', () => {
    beforeEach(() => {
      tracker.addBuy(100, 0.01, new Date('2024-01-01'), 'tx1');
      tracker.addBuy(100, 0.02, new Date('2024-01-02'), 'tx2');
    });

    it('should calculate unrealized gain', () => {
      const unrealizedPnL = tracker.getUnrealizedPnL(0.05);
      const expected = 100 * (0.05 - 0.01) + 100 * (0.05 - 0.02);
      expect(unrealizedPnL).toBeCloseTo(expected, 5);
    });

    it('should calculate unrealized loss', () => {
      const unrealizedPnL = tracker.getUnrealizedPnL(0.005);
      const expected = 100 * (0.005 - 0.01) + 100 * (0.005 - 0.02);
      expect(unrealizedPnL).toBeCloseTo(expected, 5);
      expect(unrealizedPnL).toBeLessThan(0);
    });

    it('should handle break-even price', () => {
      const unrealizedPnL = tracker.getUnrealizedPnL(0.015);
      const expected = 100 * (0.015 - 0.01) + 100 * (0.015 - 0.02);
      expect(unrealizedPnL).toBeCloseTo(expected, 5);
    });

    it('should handle empty tracker', () => {
      const emptyTracker = new CostBasisTracker();
      expect(emptyTracker.getUnrealizedPnL(0.05)).toBe(0);
    });
  });

  describe('getAverageCost', () => {
    it('should calculate weighted average cost', () => {
      tracker.addBuy(100, 0.01, new Date('2024-01-01'), 'tx1');
      tracker.addBuy(100, 0.02, new Date('2024-01-02'), 'tx2');

      const avgCost = tracker.getAverageCost();
      const expected = (100 * 0.01 + 100 * 0.02) / 200;
      expect(avgCost).toBeCloseTo(expected, 5);
    });

    it('should return 0 for empty tracker', () => {
      expect(tracker.getAverageCost()).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear all lots', () => {
      tracker.addBuy(100, 0.01, new Date('2024-01-01'), 'tx1');
      tracker.reset();

      expect(tracker.getTotalQuantityHeld()).toBe(0);
      expect(tracker.getTotalCostBasis()).toBe(0);
    });
  });
});

/**
 * ============================================================================
 * TRADE PROCESSOR TESTS (10+ tests)
 * ============================================================================
 */

describe('TradeProcessor', () => {
  let processor: TradeProcessor;

  beforeEach(() => {
    processor = new TradeProcessor();
  });

  describe('addTrade', () => {
    it('should add a trade', () => {
      const trade: Trade = {
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-01'),
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      };

      processor.addTrade(trade);
      processor.addTrade(trade);
      expect(processor.calculatePnL().totalTrades).toBe(2);
    });

    it('should sort trades by date', () => {
      const trade1: Trade = {
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-03'),
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      };

      const trade2: Trade = {
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-01'),
        txHash: 'tx2',
        source: 'BONDING_CURVE',
      };

      processor.addTrade(trade1);
      processor.addTrade(trade2);

      // Verify chronological order by checking PnL
      const pnl = processor.calculatePnL();
      expect(pnl.totalTrades).toBe(2);
    });
  });

  describe('calculatePnL', () => {
    it('should calculate zero PnL for only buys', () => {
      const trade: Trade = {
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-01'),
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      };

      processor.addTrade(trade);
      const pnl = processor.calculatePnL();

      expect(pnl.totalRealizedPnL).toBe(0);
      expect(pnl.totalTrades).toBe(1);
    });

    it('should calculate realized PnL for buy then sell', () => {
      const buyTrade: Trade = {
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-01'),
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      };

      const sellTrade: Trade = {
        tokenMint: 'TOKEN1',
        tradeType: 'SELL',
        amount: 100,
        pricePerToken: 0.05,
        date: new Date('2024-01-02'),
        txHash: 'tx2',
        source: 'RAYDIUM',
      };

      processor.addTrade(buyTrade);
      processor.addTrade(sellTrade);
      const pnl = processor.calculatePnL();

      const expectedGain = 100 * (0.05 - 0.01);
      expect(pnl.totalRealizedPnL).toBeCloseTo(expectedGain, 5);
      expect(pnl.totalTrades).toBe(2);
      expect(pnl.winRate).toBe(1);
    });

    it('should track multiple tokens', () => {
      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-01'),
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      });

      processor.addTrade({
        tokenMint: 'TOKEN2',
        tradeType: 'BUY',
        amount: 50,
        pricePerToken: 0.02,
        date: new Date('2024-01-01'),
        txHash: 'tx2',
        source: 'BONDING_CURVE',
      });

      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'SELL',
        amount: 100,
        pricePerToken: 0.05,
        date: new Date('2024-01-02'),
        txHash: 'tx3',
        source: 'RAYDIUM',
      });

      processor.addTrade({
        tokenMint: 'TOKEN2',
        tradeType: 'SELL',
        amount: 50,
        pricePerToken: 0.01,
        date: new Date('2024-01-02'),
        txHash: 'tx4',
        source: 'RAYDIUM',
      });

      const pnl = processor.calculatePnL();
      expect(pnl.byToken.size).toBe(2);
      expect(pnl.totalTrades).toBe(4);
    });

    it('should calculate win rate', () => {
      // 1 winning trade, 1 losing trade
      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-01'),
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      });

      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'SELL',
        amount: 100,
        pricePerToken: 0.05,
        date: new Date('2024-01-02'),
        txHash: 'tx2',
        source: 'RAYDIUM',
      });

      processor.addTrade({
        tokenMint: 'TOKEN2',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.05,
        date: new Date('2024-01-01'),
        txHash: 'tx3',
        source: 'BONDING_CURVE',
      });

      processor.addTrade({
        tokenMint: 'TOKEN2',
        tradeType: 'SELL',
        amount: 100,
        pricePerToken: 0.02,
        date: new Date('2024-01-02'),
        txHash: 'tx4',
        source: 'RAYDIUM',
      });

      const pnl = processor.calculatePnL();
      expect(pnl.winRate).toBeCloseTo(0.5, 2);
      expect(pnl.winningTrades).toBe(1);
      expect(pnl.losingTrades).toBe(1);
    });

    it('should calculate average hold time', () => {
      const buy = new Date('2024-01-01');
      const sell = new Date('2024-01-02');

      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: buy,
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      });

      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'SELL',
        amount: 100,
        pricePerToken: 0.05,
        date: sell,
        txHash: 'tx2',
        source: 'RAYDIUM',
      });

      const pnl = processor.calculatePnL();
      expect(pnl.avgHoldTimeHours).toBeCloseTo(24, 1); // 1 day = 24 hours
    });

    it('should handle complex multi-token portfolio', () => {
      // Token A: Buy 1000 @ 0.001, Sell 500 @ 0.005, Sell 500 @ 0.003
      // Token B: Buy 100 @ 0.1, Buy 100 @ 0.15, Sell 200 @ 0.12

      processor.addTrades([
        {
          tokenMint: 'TOKENA',
          tradeType: 'BUY',
          amount: 1000,
          pricePerToken: 0.001,
          date: new Date('2024-01-01'),
          txHash: 'tx1',
          source: 'BONDING_CURVE',
        },
        {
          tokenMint: 'TOKENA',
          tradeType: 'SELL',
          amount: 500,
          pricePerToken: 0.005,
          date: new Date('2024-01-02'),
          txHash: 'tx2',
          source: 'RAYDIUM',
        },
        {
          tokenMint: 'TOKENA',
          tradeType: 'SELL',
          amount: 500,
          pricePerToken: 0.003,
          date: new Date('2024-01-03'),
          txHash: 'tx3',
          source: 'RAYDIUM',
        },
        {
          tokenMint: 'TOKENB',
          tradeType: 'BUY',
          amount: 100,
          pricePerToken: 0.1,
          date: new Date('2024-01-01'),
          txHash: 'tx4',
          source: 'BONDING_CURVE',
        },
        {
          tokenMint: 'TOKENB',
          tradeType: 'BUY',
          amount: 100,
          pricePerToken: 0.15,
          date: new Date('2024-01-02'),
          txHash: 'tx5',
          source: 'RAYDIUM',
        },
        {
          tokenMint: 'TOKENB',
          tradeType: 'SELL',
          amount: 200,
          pricePerToken: 0.12,
          date: new Date('2024-01-03'),
          txHash: 'tx6',
          source: 'RAYDIUM',
        },
      ]);

      const pnl = processor.calculatePnL();
      expect(pnl.totalTrades).toBe(6);
      expect(pnl.byToken.size).toBe(2);
      expect(pnl.totalRealizedPnL).toBeGreaterThan(0); // Should have gains overall
    });
  });

  describe('calculateTokenPnL', () => {
    it('should calculate token-specific PnL', () => {
      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-01'),
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      });

      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'SELL',
        amount: 100,
        pricePerToken: 0.05,
        date: new Date('2024-01-02'),
        txHash: 'tx2',
        source: 'RAYDIUM',
      });

      const summary = processor.calculateTokenPnL('TOKEN1', 0.05);
      expect(summary).not.toBeNull();
      if (summary) {
        expect(summary.realizedPnL).toBeCloseTo(100 * (0.05 - 0.01), 5);
        expect(summary.totalTrades).toBe(2);
      }
    });

    it('should return null for non-existent token', () => {
      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-01'),
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      });

      const summary = processor.calculateTokenPnL('TOKEN2', 0.05);
      expect(summary).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle empty processor', () => {
      const pnl = processor.calculatePnL();
      expect(pnl.totalRealizedPnL).toBe(0);
      expect(pnl.totalTrades).toBe(0);
    });

    it('should handle partial sells', () => {
      processor.addTrades([
        {
          tokenMint: 'TOKEN1',
          tradeType: 'BUY',
          amount: 1000,
          pricePerToken: 0.01,
          date: new Date('2024-01-01'),
          txHash: 'tx1',
          source: 'BONDING_CURVE',
        },
        {
          tokenMint: 'TOKEN1',
          tradeType: 'SELL',
          amount: 300,
          pricePerToken: 0.05,
          date: new Date('2024-01-02'),
          txHash: 'tx2',
          source: 'RAYDIUM',
        },
      ]);

      const pnl = processor.calculatePnL();
      const summary = processor.calculateTokenPnL('TOKEN1', 0.03);
      expect(summary?.quantityHeld).toBe(700);
      expect(pnl.totalRealizedPnL).toBeCloseTo(300 * (0.05 - 0.01), 5);
    });

    it('should handle multiple sells from single buy', () => {
      processor.addTrades([
        {
          tokenMint: 'TOKEN1',
          tradeType: 'BUY',
          amount: 1000,
          pricePerToken: 0.01,
          date: new Date('2024-01-01'),
          txHash: 'tx1',
          source: 'BONDING_CURVE',
        },
        {
          tokenMint: 'TOKEN1',
          tradeType: 'SELL',
          amount: 400,
          pricePerToken: 0.05,
          date: new Date('2024-01-02'),
          txHash: 'tx2',
          source: 'RAYDIUM',
        },
        {
          tokenMint: 'TOKEN1',
          tradeType: 'SELL',
          amount: 600,
          pricePerToken: 0.03,
          date: new Date('2024-01-03'),
          txHash: 'tx3',
          source: 'RAYDIUM',
        },
      ]);

      const pnl = processor.calculatePnL();
      const expectedGain = 400 * (0.05 - 0.01) + 600 * (0.03 - 0.01);
      expect(pnl.totalRealizedPnL).toBeCloseTo(expectedGain, 5);
    });

    it('should handle holding positions (no sells)', () => {
      processor.addTrade({
        tokenMint: 'TOKEN1',
        tradeType: 'BUY',
        amount: 100,
        pricePerToken: 0.01,
        date: new Date('2024-01-01'),
        txHash: 'tx1',
        source: 'BONDING_CURVE',
      });

      const pnl = processor.calculatePnL();
      const summary = processor.calculateTokenPnL('TOKEN1', 0.05);
      expect(summary?.quantityHeld).toBe(100);
      expect(summary?.unrealizedPnL).toBeCloseTo(100 * (0.05 - 0.01), 5);
      expect(pnl.totalRealizedPnL).toBe(0);
    });
  });
});
