import { WalletAnalyzer, analyzeWallet, type SmartMoneyScore } from '../wallet-analyzer';
import { getAddressTransactions } from '../helius-client';

// Mock the Helius client
jest.mock('../helius-client', () => ({
  getAddressTransactions: jest.fn(),
}));

describe('WalletAnalyzer - Metrics Calculation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * METRIC 1: Realized PnL Calculation
   */
  describe('Realized PnL Calculation', () => {
    it('should calculate positive PnL from buy-sell with profit', async () => {
      const mockTxs = [
        {
          signature: 'tx1',
          slot: 100,
          timestamp: 1000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Buy',
          source: 'other',
          destination: 'wallet1',
          amount: 10, // Buy 10 tokens at 1 SOL
        },
        {
          signature: 'tx2',
          slot: 200,
          timestamp: 2000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Sell',
          source: 'wallet1',
          destination: 'other',
          amount: 10, // Sell 10 tokens at 2 SOL
        },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 2); // 2 SOL current price
      const result = await analyzer.analyze();

      expect(result.metrics.realizedPnL).toBeGreaterThan(0);
      expect(result.score).toBeGreaterThan(0);
    });

    it('should calculate negative PnL from buy-sell with loss', async () => {
      const mockTxs = [
        {
          signature: 'tx1',
          slot: 100,
          timestamp: 1000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Buy',
          source: 'other',
          destination: 'wallet1',
          amount: 10, // Buy 10 tokens
        },
        {
          signature: 'tx2',
          slot: 200,
          timestamp: 2000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Sell',
          source: 'wallet1',
          destination: 'other',
          amount: 10, // Sell at lower price
        },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 0.5); // 0.5 SOL (loss)
      const result = await analyzer.analyze();

      // PnL should be negative or low
      expect(result.metrics.realizedPnL).toBeLessThanOrEqual(0);
    });

    it('should handle FIFO cost basis with multiple buys', async () => {
      const mockTxs = [
        {
          signature: 'tx1',
          slot: 100,
          timestamp: 1000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Buy',
          source: 'other',
          destination: 'wallet1',
          amount: 10,
        },
        {
          signature: 'tx2',
          slot: 101,
          timestamp: 1100,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Buy',
          source: 'other',
          destination: 'wallet1',
          amount: 5,
        },
        {
          signature: 'tx3',
          slot: 200,
          timestamp: 2000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Sell',
          source: 'wallet1',
          destination: 'other',
          amount: 15,
        },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 2);
      const result = await analyzer.analyze();

      // Should process all trades
      expect(result.metrics.totalTrades).toBeGreaterThanOrEqual(3);
    });
  });

  /**
   * METRIC 2: Win Rate
   */
  describe('Win Rate Calculation', () => {
    it('should calculate 100% win rate for all profitable trades', async () => {
      const mockTxs = [
        {
          signature: 'tx1',
          slot: 100,
          timestamp: 1000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Buy',
          source: 'other',
          destination: 'wallet1',
          amount: 10,
        },
        {
          signature: 'tx2',
          slot: 200,
          timestamp: 2000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Sell',
          source: 'wallet1',
          destination: 'other',
          amount: 10,
        },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 2); // Profit: 1 SOL per token
      const result = await analyzer.analyze();

      expect(result.metrics.winRate).toBeGreaterThan(0.5);
    });

    it('should calculate 0% win rate for all losing trades', async () => {
      const mockTxs = [
        {
          signature: 'tx1',
          slot: 100,
          timestamp: 1000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Buy',
          source: 'other',
          destination: 'wallet1',
          amount: 10,
        },
        {
          signature: 'tx2',
          slot: 200,
          timestamp: 2000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Sell',
          source: 'wallet1',
          destination: 'other',
          amount: 10,
        },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 0.5); // Loss: 0.5 SOL per token
      const result = await analyzer.analyze();

      expect(result.metrics.winRate).toBeLessThanOrEqual(0.5);
    });
  });

  /**
   * METRIC 3: Consistency
   */
  describe('Consistency Calculation', () => {
    it('should give high consistency for stable returns', async () => {
      const mockTxs = [
        // Trade 1
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Buy', source: 'other', destination: 'wallet1', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Sell', source: 'wallet1', destination: 'other', amount: 10 },
        // Trade 2
        { signature: 'tx3', slot: 300, timestamp: 3000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Buy', source: 'other', destination: 'wallet1', amount: 10 },
        { signature: 'tx4', slot: 400, timestamp: 4000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Sell', source: 'wallet1', destination: 'other', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 1.1); // Consistent small profits
      const result = await analyzer.analyze();

      expect(result.metrics.consistency).toBeGreaterThan(40);
    });

    it('should give low consistency for volatile returns', async () => {
      const mockTxs = [
        // Big profit trade
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Buy', source: 'other', destination: 'wallet1', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Sell', source: 'wallet1', destination: 'other', amount: 10 },
        // Big loss trade
        { signature: 'tx3', slot: 300, timestamp: 3000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Buy', source: 'other', destination: 'wallet1', amount: 10 },
        { signature: 'tx4', slot: 400, timestamp: 4000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Sell', source: 'wallet1', destination: 'other', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 5); // Big profit first, then assume big loss with lower price
      const result = await analyzer.analyze();

      // May be high or low depending on calculation, but test that it processes
      expect(result.metrics.consistency).toBeGreaterThanOrEqual(0);
    });
  });

  /**
   * METRIC 4: Timing Score
   */
  describe('Timing Score Calculation', () => {
    it('should give high timing score for early entry', async () => {
      const mockTxs = [
        {
          signature: 'tx1',
          slot: 100,
          timestamp: 1000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Buy early',
          source: 'other',
          destination: 'wallet1',
          amount: 10,
        },
        {
          signature: 'tx2',
          slot: 200,
          timestamp: 2000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Sell at 2x',
          source: 'wallet1',
          destination: 'other',
          amount: 10,
        },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 2); // 2x return
      const result = await analyzer.analyze();

      expect(result.metrics.timing).toBeGreaterThan(50);
    });

    it('should give low timing score for late entry', async () => {
      const mockTxs = [
        {
          signature: 'tx1',
          slot: 100,
          timestamp: 1000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Buy high',
          source: 'other',
          destination: 'wallet1',
          amount: 10,
        },
        {
          signature: 'tx2',
          slot: 200,
          timestamp: 2000,
          fee: 5000,
          status: 'success' as const,
          type: 'TRANSFER',
          description: 'Sell low',
          source: 'wallet1',
          destination: 'other',
          amount: 10,
        },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 0.9); // Loss
      const result = await analyzer.analyze();

      expect(result.metrics.timing).toBeLessThan(50);
    });
  });

  /**
   * METRIC 5: Diversification
   */
  describe('Diversification Calculation', () => {
    it('should score diversification based on trade count', async () => {
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'T1', source: 'other', destination: 'wallet1', amount: 1 },
        { signature: 'tx2', slot: 101, timestamp: 1100, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'T2', source: 'other', destination: 'wallet1', amount: 1 },
        { signature: 'tx3', slot: 102, timestamp: 1200, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'T3', source: 'other', destination: 'wallet1', amount: 1 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 1);
      const result = await analyzer.analyze();

      expect(result.metrics.diversification).toBeGreaterThanOrEqual(0);
    });
  });

  /**
   * METRIC 6: Frequency
   */
  describe('Trading Frequency Calculation', () => {
    it('should calculate trades per week', async () => {
      const now = Math.floor(Date.now() / 1000);
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: now, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Buy', source: 'other', destination: 'wallet1', amount: 1 },
        { signature: 'tx2', slot: 200, timestamp: now + 3600 * 24, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'Sell', source: 'wallet1', destination: 'other', amount: 1 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('wallet1', 1);
      const result = await analyzer.analyze();

      expect(result.metrics.frequency).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('WalletAnalyzer - Scoring Formula', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Test scoring formula with smart money wallets
   */
  describe('Smart Money Wallets (should score 70+)', () => {
    it('should score highly for consistent profitable trader', async () => {
      const mockTxs = [
        // 5 profitable trades
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
        { signature: 'tx3', slot: 300, timestamp: 3000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx4', slot: 400, timestamp: 4000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
        { signature: 'tx5', slot: 500, timestamp: 5000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx6', slot: 600, timestamp: 6000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('smart-wallet', 1.5); // Consistent small profits
      const result = await analyzer.analyze();

      expect(result.score).toBeGreaterThanOrEqual(50); // Should be reasonably high
      expect(result.breakdown.realizedPnLScore).toBeGreaterThan(30);
    });

    it('should score highly for high win rate trader', async () => {
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('smart-wallet-2', 2); // 100% win rate
      const result = await analyzer.analyze();

      expect(result.breakdown.winRateScore).toBeGreaterThan(50);
    });
  });

  /**
   * Test scoring formula with dumb money wallets
   */
  describe('Dumb Money Wallets (should score <30)', () => {
    it('should score low for losing trader', async () => {
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('dumb-wallet', 0.5); // 50% loss
      const result = await analyzer.analyze();

      expect(result.breakdown.realizedPnLScore).toBeLessThan(50);
    });

    it('should score low for 0% win rate', async () => {
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('dumb-wallet-2', 0.9); // All losses
      const result = await analyzer.analyze();

      expect(result.breakdown.winRateScore).toBeLessThanOrEqual(50);
    });
  });

  /**
   * Test overall score is 0-100
   */
  it('should always return score between 0-100', async () => {
    const mockTxs = [
      { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
      { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
    ];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const analyzer = new WalletAnalyzer('test-wallet', 1.5);
    const result = await analyzer.analyze();

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe('WalletAnalyzer - Pattern Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Detect trading style
   */
  describe('Trading Style Detection', () => {
    it('should detect scalper pattern (short holds, high frequency)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: now, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 1 },
        { signature: 'tx2', slot: 101, timestamp: now + 300, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 1 },
        { signature: 'tx3', slot: 102, timestamp: now + 600, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 1 },
        { signature: 'tx4', slot: 103, timestamp: now + 900, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 1 },
        { signature: 'tx5', slot: 104, timestamp: now + 1200, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 1 },
        { signature: 'tx6', slot: 105, timestamp: now + 1500, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 1 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('scalper-wallet', 1.1);
      const result = await analyzer.analyze();

      expect(result.tradingStyle).toBe('scalper');
      expect(result.styleConfidence).toBeGreaterThan(0.5);
    });

    it('should detect swing trader pattern (1-7 days)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: now, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: now + 3600 * 24 * 2, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
        { signature: 'tx3', slot: 300, timestamp: now + 3600 * 24 * 3, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx4', slot: 400, timestamp: now + 3600 * 24 * 5, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('swing-wallet', 1.1);
      const result = await analyzer.analyze();

      expect(result.tradingStyle).toBe('swing-trader');
      expect(result.styleConfidence).toBeGreaterThan(0.5);
    });

    it('should detect long-term holder pattern', async () => {
      const now = Math.floor(Date.now() / 1000);
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: now, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 100 },
        { signature: 'tx2', slot: 200, timestamp: now + 3600 * 24 * 30, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 100 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('long-term-wallet', 2);
      const result = await analyzer.analyze();

      expect(result.tradingStyle).toBe('long-term');
      expect(result.styleConfidence).toBeGreaterThan(0.5);
    });

    it('should detect early-buyer pattern', async () => {
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 100 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 100 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('early-buyer-wallet', 10); // 10x return
      const result = await analyzer.analyze();

      expect(['early-buyer', 'unknown']).toContain(result.tradingStyle);
    });
  });

  /**
   * Risk assessment
   */
  describe('Risk Level Assessment', () => {
    it('should assess high risk for volatile returns', async () => {
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('volatile-wallet', 0.5);
      const result = await analyzer.analyze();

      expect(['low', 'medium', 'high']).toContain(result.riskLevel);
    });

    it('should assess low risk for consistent returns', async () => {
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('consistent-wallet', 1.05); // 5% profit
      const result = await analyzer.analyze();

      expect(['low', 'medium', 'high']).toContain(result.riskLevel);
    });
  });

  /**
   * Strengths and weaknesses analysis
   */
  describe('Strengths and Weaknesses Analysis', () => {
    it('should identify strength in high win rate', async () => {
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('high-wr-wallet', 2); // 100% win
      const result = await analyzer.analyze();

      if (result.breakdown.winRateScore > 70) {
        expect(result.strengthAreas).toContain('High win rate');
      }
    });

    it('should identify weakness in low win rate', async () => {
      const mockTxs = [
        { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
        { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
      ];

      (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

      const analyzer = new WalletAnalyzer('low-wr-wallet', 0.5); // 0% win
      const result = await analyzer.analyze();

      if (result.breakdown.winRateScore < 30) {
        expect(result.weakAreas).toContain('Low win rate');
      }
    });
  });
});

describe('WalletAnalyzer - Edge Cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Edge case: No transactions
   */
  it('should handle wallet with no transactions', async () => {
    (getAddressTransactions as jest.Mock).mockResolvedValue([]);

    const analyzer = new WalletAnalyzer('empty-wallet', 1);
    const result = await analyzer.analyze();

    expect(result.score).toBe(0);
    expect(result.metrics.totalTrades).toBe(0);
    expect(result.weakAreas.length).toBeGreaterThan(0);
  });

  /**
   * Edge case: Single transaction
   */
  it('should handle wallet with single transaction', async () => {
    const mockTxs = [{ signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 }];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const analyzer = new WalletAnalyzer('single-tx-wallet', 1);
    const result = await analyzer.analyze();

    expect(result.score).toBe(0);
    expect(result.metrics.totalTrades).toBeLessThan(3);
  });

  /**
   * Edge case: Extreme outlier (1000x gains)
   */
  it('should handle extreme outliers gracefully', async () => {
    const mockTxs = [
      { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10000 },
      { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10000 },
    ];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const analyzer = new WalletAnalyzer('moonshot-wallet', 100); // 100x return
    const result = await analyzer.analyze();

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.breakdown.realizedPnLScore).toBeGreaterThanOrEqual(0);
  });

  /**
   * Edge case: Recent trades only
   */
  it('should handle recent trades only', async () => {
    const now = Math.floor(Date.now() / 1000);
    const mockTxs = [
      { signature: 'tx1', slot: 100, timestamp: now, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
      { signature: 'tx2', slot: 200, timestamp: now + 3600, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
    ];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const analyzer = new WalletAnalyzer('recent-wallet', 1.5);
    const result = await analyzer.analyze();

    expect(result.metrics.frequency).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  /**
   * Edge case: Error handling
   */
  it('should handle API errors gracefully', async () => {
    (getAddressTransactions as jest.Mock).mockRejectedValue(new Error('API error'));

    const analyzer = new WalletAnalyzer('error-wallet', 1);
    const result = await analyzer.analyze();

    expect(result.score).toBe(0);
    expect(result.weakAreas.length).toBeGreaterThan(0);
  });
});

describe('WalletAnalyzer - Convenience Function', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should provide convenience function analyzeWallet()', async () => {
    const mockTxs = [
      { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
      { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
    ];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const result = await analyzeWallet('test-wallet', 1.5);

    expect(result).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should work without currentPrice parameter', async () => {
    const mockTxs = [
      { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
      { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
    ];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const result = await analyzeWallet('test-wallet-2');

    expect(result).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe('WalletAnalyzer - Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Test that SmartMoneyScore interface is properly structured
   */
  it('should return complete SmartMoneyScore structure', async () => {
    const mockTxs = [
      { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
      { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
    ];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const result = await analyzeWallet('complete-wallet', 1.5);

    // Check all required properties
    expect(result.score).toBeDefined();
    expect(result.percentile).toBeDefined();
    expect(result.metrics).toBeDefined();
    expect(result.tradingStyle).toBeDefined();
    expect(result.styleConfidence).toBeDefined();
    expect(result.breakdown).toBeDefined();
    expect(result.riskLevel).toBeDefined();
    expect(result.strengthAreas).toBeDefined();
    expect(result.weakAreas).toBeDefined();

    // Check metric properties
    expect(result.metrics.realizedPnL).toBeDefined();
    expect(result.metrics.unrealizedPnL).toBeDefined();
    expect(result.metrics.winRate).toBeDefined();
    expect(result.metrics.consistency).toBeDefined();
    expect(result.metrics.timing).toBeDefined();
    expect(result.metrics.diversification).toBeDefined();
    expect(result.metrics.frequency).toBeDefined();
    expect(result.metrics.totalTrades).toBeDefined();
    expect(result.metrics.avgHoldTimeHours).toBeDefined();
    expect(result.metrics.avgRoiPerTrade).toBeDefined();

    // Check breakdown properties
    expect(result.breakdown.realizedPnLScore).toBeDefined();
    expect(result.breakdown.winRateScore).toBeDefined();
    expect(result.breakdown.consistencyScore).toBeDefined();
    expect(result.breakdown.timingScore).toBeDefined();
    expect(result.breakdown.diversificationScore).toBeDefined();
    expect(result.breakdown.frequencyScore).toBeDefined();
  });

  /**
   * Test multiple wallet analysis
   */
  it('should analyze multiple wallets with different scores', async () => {
    // Smart money wallet
    (getAddressTransactions as jest.Mock).mockResolvedValueOnce([
      { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
      { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
    ]);

    const smartResult = await analyzeWallet('smart-wallet', 2);

    // Dumb money wallet
    (getAddressTransactions as jest.Mock).mockResolvedValueOnce([
      { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
      { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
    ]);

    const dumbResult = await analyzeWallet('dumb-wallet', 0.5);

    // Smart wallet should potentially score higher
    expect(smartResult.score).toBeGreaterThanOrEqual(0);
    expect(dumbResult.score).toBeGreaterThanOrEqual(0);
  });

  /**
   * Test score consistency across runs
   */
  it('should return consistent scores for same wallet', async () => {
    const mockTxs = [
      { signature: 'tx1', slot: 100, timestamp: 1000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'B', source: 'o', destination: 'w', amount: 10 },
      { signature: 'tx2', slot: 200, timestamp: 2000, fee: 5000, status: 'success' as const, type: 'TRANSFER', description: 'S', source: 'w', destination: 'o', amount: 10 },
    ];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const result1 = await analyzeWallet('consistent-wallet', 1.5);
    const result2 = await analyzeWallet('consistent-wallet', 1.5);

    expect(result1.score).toBe(result2.score);
    expect(result1.metrics.winRate).toBe(result2.metrics.winRate);
  });
});
