# PnL Engine Quick Start Guide for Agent 6

This guide shows how to integrate the PnL engine into the wallet analyzer for smart money detection.

## Import

```typescript
import {
  TradeProcessor,
  BondingCurveCalculator,
  AMMSwapCalculator,
  CostBasisTracker,
  Trade,
  PortfolioPnL,
  TokenPnLSummary,
} from './pnl-engine';
```

## Basic Integration Pattern

### Step 1: Convert wallet transactions to Trade objects

```typescript
function convertTransactionsToTrades(transactions: any[]): Trade[] {
  return transactions
    .filter(tx => isTokenTransfer(tx))
    .map(tx => ({
      tokenMint: tx.mint,
      tradeType: detectTradeType(tx), // 'BUY' or 'SELL'
      amount: tx.tokenAmount,
      pricePerToken: calculatePrice(tx), // SOL per token
      date: new Date(tx.timestamp * 1000),
      txHash: tx.signature,
      source: detectDEX(tx), // 'BONDING_CURVE', 'RAYDIUM', etc.
    }));
}
```

### Step 2: Calculate portfolio PnL

```typescript
function analyzeWallet(transactions: any[]): PortfolioPnL {
  const trades = convertTransactionsToTrades(transactions);
  const processor = new TradeProcessor();
  processor.addTrades(trades);
  return processor.calculatePnL();
}
```

### Step 3: Use metrics for scoring

```typescript
function calculateSmartMoneyScore(pnl: PortfolioPnL): number {
  const realizedPnLScore = Math.min(pnl.totalRealizedPnLPct, 500); // Cap at 500%
  const winRateScore = pnl.winRate * 100; // 0-100
  const consistencyScore = calculateConsistency(pnl);

  return (
    realizedPnLScore * 0.5 +      // 50% weight on actual returns
    winRateScore * 0.3 +          // 30% weight on win rate
    consistencyScore * 0.2        // 20% weight on consistency
  );
}
```

## Key Metrics from PortfolioPnL

```typescript
const pnl = processor.calculatePnL();

// Realized gains
console.log(pnl.totalRealizedPnL);        // SOL amount gained
console.log(pnl.totalRealizedPnLPct);     // Percentage gains

// Trading quality
console.log(pnl.winRate);                 // 0-1 (0.6 = 60% wins)
console.log(pnl.winningTrades);           // Count of profitable trades
console.log(pnl.losingTrades);            // Count of losing trades

// Risk metrics
console.log(pnl.largestWin);              // Biggest single trade gain
console.log(pnl.largestLoss);             // Biggest single trade loss
console.log(pnl.profitFactor);            // Total wins / total losses

// Timing
console.log(pnl.avgHoldTimeHours);        // Average hours between buy/sell

// Per-token breakdown
pnl.byToken.forEach((token: TokenPnLSummary, mint: string) => {
  console.log(`${mint}:`);
  console.log(`  Realized: ${token.realizedPnL} SOL`);
  console.log(`  Unrealized: ${token.unrealizedPnL} SOL`);
  console.log(`  Quantity held: ${token.quantityHeld}`);
});
```

## Common Patterns

### Pattern 1: Get wallet PnL in one line

```typescript
const pnl = new TradeProcessor().addTrades(trades).calculatePnL();
```

### Pattern 2: Analyze specific token performance

```typescript
const tokensWithPositiveReturns = Array.from(pnl.byToken.values())
  .filter(t => t.realizedPnLPct > 50)
  .sort((a, b) => b.realizedPnLPct - a.realizedPnLPct);
```

### Pattern 3: Find timing edge (early buyers)

```typescript
const avgHoldTime = pnl.avgHoldTimeHours;
const hasTimingEdge = avgHoldTime < 48; // Holds tokens < 2 days on average

// Combined with win rate = good timing
const isTimingPlayer = hasTimingEdge && pnl.winRate > 0.6;
```

### Pattern 4: Calculate month-over-month consistency

```typescript
// Calculate PnL for different time windows
const pnl90days = getPortfolioPnL(trades.slice(-90));
const pnl30days = getPortfolioPnL(trades.slice(-30));
const pnl7days = getPortfolioPnL(trades.slice(-7));

// Check consistency
const isConsistent = 
  pnl90days.winRate > 0.5 &&
  pnl30days.winRate > 0.5 &&
  pnl7days.winRate > 0.5;
```

## Type Definitions to Know

### Trade
```typescript
interface Trade {
  tokenMint: string;
  tradeType: 'BUY' | 'SELL';
  amount: number;
  pricePerToken: number;  // SOL per token
  date: Date;
  txHash: string;
  source: 'BONDING_CURVE' | 'RAYDIUM' | 'ORCA' | 'JUPITER';
}
```

### PortfolioPnL
```typescript
interface PortfolioPnL {
  totalRealizedPnL: number;        // SOL
  totalUnrealizedPnL: number;      // SOL
  totalRealizedPnLPct: number;     // Percent
  winRate: number;                 // 0-1
  avgHoldTimeHours: number;        // Hours
  winningTrades: number;           // Count
  losingTrades: number;            // Count
  largestWin: number;              // SOL
  largestLoss: number;             // SOL
  profitFactor: number;            // Wins / Losses
  byToken: Map<string, TokenPnLSummary>;
}
```

### TokenPnLSummary
```typescript
interface TokenPnLSummary {
  mint: string;
  totalCostBasis: number;          // Total SOL spent
  totalSaleProceeds: number;       // Total SOL received from sales
  realizedPnL: number;             // Realized gain/loss
  realizedPnLPct: number;          // Realized gain/loss %
  unrealizedPnL: number;           // Current holdings unrealized
  quantityHeld: number;            // Tokens still held
  avgHoldTimeHours: number;        // Average hold time per trade
  winningTrades: number;           // Count of wins
  totalTrades: number;             // Count of all trades
}
```

## Performance Tips

### Caching
Since PnL calculation is deterministic, cache results by trade hash:

```typescript
const tradeHash = createHash('sha256')
  .update(JSON.stringify(trades))
  .digest('hex');

if (cache.has(tradeHash)) {
  return cache.get(tradeHash);
}

const pnl = processor.calculatePnL();
cache.set(tradeHash, pnl);
```

### Batch Processing
Process multiple wallets in parallel:

```typescript
const results = await Promise.all(
  wallets.map(wallet => analyzeWallet(wallet))
);
```

### Incremental Updates
Only recalculate for new trades:

```typescript
// Load previous state
const previousPnL = loadFromDatabase(wallet);
const newTrades = getNewTrades(wallet);

// Only process new trades if implementing incremental logic
// (Note: current implementation recalculates all, which is safer)
```

## Testing Your Integration

```typescript
it('should calculate wallet PnL correctly', () => {
  const trades: Trade[] = [
    {
      tokenMint: 'TEST',
      tradeType: 'BUY',
      amount: 100,
      pricePerToken: 0.01,
      date: new Date('2024-01-01'),
      txHash: 'tx1',
      source: 'BONDING_CURVE',
    },
    {
      tokenMint: 'TEST',
      tradeType: 'SELL',
      amount: 100,
      pricePerToken: 0.05,
      date: new Date('2024-01-02'),
      txHash: 'tx2',
      source: 'RAYDIUM',
    },
  ];

  const processor = new TradeProcessor();
  processor.addTrades(trades);
  const pnl = processor.calculatePnL();

  expect(pnl.totalRealizedPnL).toBeCloseTo(4, 0); // 100 * (0.05 - 0.01)
  expect(pnl.winRate).toBe(1); // 100% win rate
  expect(pnl.avgHoldTimeHours).toBeCloseTo(24, 1); // ~1 day
});
```

## Debugging

### Check individual token details
```typescript
const tokenPnL = pnl.byToken.get('MINT_ADDRESS');
console.log('Token summary:', tokenPnL);
```

### Verify FIFO matching
```typescript
// The cost basis tracker processes in date order
// Check that trades are sorted chronologically
console.log('First trade:', trades[0].date);
console.log('Last trade:', trades[trades.length - 1].date);
```

### Validate prices
```typescript
// Check that prices are reasonable
trades.forEach(trade => {
  console.log(`${trade.tokenMint} @ ${trade.pricePerToken} SOL`);
  if (trade.pricePerToken > 10) {
    console.warn('Unusually high price, check decimals');
  }
});
```

## Questions?

See `lib/PNL_ENGINE_README.md` for full documentation and examples.

See `AGENT_BRIEFS/BONDING_CURVE_MATH.md`, `AMM_SWAP_MATH.md`, `FIFO_ALGORITHM.md`, and `PORTFOLIO_PNL.md` for mathematical foundations.
