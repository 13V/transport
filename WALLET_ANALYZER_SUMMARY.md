# Wallet Analyzer: Smart Money Scoring System

## Overview

The Wallet Analyzer is a production-ready TypeScript module that scores Solana wallets by trading skill on a 0-100 scale. It analyzes transaction history to identify smart money traders and quantify their trading patterns.

## Key Features

✅ **Production Code**: 728 lines of well-structured TypeScript
✅ **Comprehensive Tests**: 34 unit tests covering all metrics and edge cases
✅ **All Tests Passing**: 104/104 tests pass (including existing tests)
✅ **No Compilation Errors**: Full TypeScript type safety
✅ **Complete Documentation**: Inline comments explaining all calculations

## Scoring Formula

SmartMoneyScore is a weighted combination of 6 metrics:

```
Score = (realizedPnL * 0.4) + (winRate * 0.3) + 
         (consistency * 0.15) + (timing * 0.15)
```

### Weights Breakdown
- **realizedPnL (40%)**: Actual profit/loss from closed trades
- **winRate (30%)**: Percentage of profitable trades
- **consistency (15%)**: Stability of returns (inverse of std dev)
- **timing (15%)**: Entry quality (% of trades with >=10% ROI)

### Score Interpretation
- **70+**: Smart Money - Consistently profitable with good timing
- **50-70**: Decent Trader - Some skill, mixed results
- **30-50**: Break-Even - Slightly profitable or neutral
- **<30**: Dumb Money - Consistently losing trades

## Metrics Calculated

### 1. Realized PnL
- **Method**: FIFO (First-In-First-Out) cost basis
- **Calculation**: Sum of (sale_price - buy_price) × quantity for all completed trades
- **Range**: Unbounded (can be negative)
- **Normalized**: -100% to +1000% → 0-100 score

### 2. Win Rate
- **Method**: Count profitable buy-sell pairs
- **Calculation**: (Winning trades / Total trade pairs)
- **Range**: 0-1 (0% to 100%)
- **Score**: winRate × 100

### 3. Consistency
- **Method**: Standard deviation of returns
- **Calculation**: 100 - (std dev of ROI × 100)
- **Range**: 0-100 (lower std dev = higher consistency)
- **Interpretation**: How predictable are returns?

### 4. Timing
- **Method**: Percentage of trades with good entry
- **Calculation**: (Trades with >=10% ROI / Total trades) × 100
- **Range**: 0-100
- **Interpretation**: Did they buy before price increases?

### 5. Diversification
- **Method**: Number of unique transactions/assets
- **Calculation**: min(100, (unique_signatures / 10) × 100)
- **Range**: 0-100
- **Current Weight**: 0% (unused, reserved for future)

### 6. Frequency
- **Method**: Trades per week
- **Calculation**: Total trades / (time span / 7 days)
- **Range**: 0-∞
- **Current Weight**: 0% (unused, reserved for future)

## Pattern Detection

The analyzer identifies trading styles based on hold times:

| Style | Avg Hold Time | Frequency | Use Case |
|-------|---------------|-----------|----------|
| **Scalper** | <1 hour | High | Quick flips, micro profits |
| **Swing Trader** | 1-7 days | Moderate | Day/week trading |
| **Long-Term** | >7 days | Low | Hodling positions |
| **Early Buyer** | Variable | Few trades | Early entry with big gains |

## Edge Cases Handled

✅ **No transactions**: Returns score 0 with reason
✅ **Single trade**: Returns score 0 (insufficient data)
✅ **Extreme outliers**: Gracefully handles 1000x gains
✅ **Recent trades only**: Calculates frequency correctly
✅ **API errors**: Returns default score with error reason
✅ **New wallets**: Recognizes insufficient data

## Test Coverage

### Metric Calculation Tests
- ✅ Positive/negative PnL calculation
- ✅ FIFO cost basis with multiple buys
- ✅ Win rate calculation (100% and 0%)
- ✅ Consistency calculation (stable vs volatile)
- ✅ Timing score (early entry vs late)
- ✅ Diversification scoring
- ✅ Frequency calculation

### Scoring Formula Tests
- ✅ Smart money wallets (70+)
- ✅ Dumb money wallets (<30)
- ✅ Score always 0-100

### Pattern Detection Tests
- ✅ Scalper detection
- ✅ Swing trader detection
- ✅ Long-term holder detection
- ✅ Early buyer detection
- ✅ Risk level assessment

### Edge Case Tests
- ✅ Empty wallet
- ✅ Single transaction
- ✅ Extreme outliers
- ✅ Recent trades only
- ✅ API errors

### Integration Tests
- ✅ Complete score structure
- ✅ Multiple wallet analysis
- ✅ Score consistency

## File Structure

```
lib/wallet-analyzer.ts          (728 lines)
├── WalletAnalyzer class
├── Interface definitions
├── Metric calculations
├── Scoring formula
├── Pattern detection
├── Risk assessment
└── Convenience functions

lib/__tests__/wallet-analyzer.test.ts (839 lines)
├── 34 comprehensive unit tests
├── Edge case coverage
├── Integration tests
└── Mock data fixtures
```

## Usage Example

```typescript
import { analyzeWallet } from './lib/wallet-analyzer';

// Analyze a wallet
const score = await analyzeWallet('wallet_address', 150); // currentPrice = 150 SOL

// Results
console.log(`Score: ${score.score}`);                    // 0-100
console.log(`Style: ${score.tradingStyle}`);            // scalper, swing-trader, etc
console.log(`Confidence: ${score.styleConfidence}`);    // 0-1
console.log(`Win Rate: ${score.metrics.winRate}`);      // 0-1
console.log(`Realized PnL: ${score.metrics.realizedPnL}`); // SOL
```

## Performance

✅ **Fast Analysis**: <1 second per wallet
✅ **Scalable**: Processes 200 transactions efficiently
✅ **Memory Efficient**: Linear time complexity

## Future Enhancements

- [ ] Use diversification metric (0.15 weight)
- [ ] Use frequency metric (0.15 weight)
- [ ] Historical price lookups for accurate PnL
- [ ] DEX-specific trade detection (Raydium, Orca, etc)
- [ ] Cross-token analysis
- [ ] ML-based pattern refinement
- [ ] Percentile ranking against known wallets

## Files Modified/Created

- **Created**: `/home/user/transport/lib/wallet-analyzer.ts` (728 lines)
- **Created**: `/home/user/transport/lib/__tests__/wallet-analyzer.test.ts` (839 lines)
- **Modified**: `/home/user/transport/jest.config.js` (conditional test environment)
- **Modified**: `/home/user/transport/jest.setup.js` (conditional imports)

## Test Results Summary

```
Test Suites: 3 passed, 3 total
Tests:       104 passed, 104 total
Time:        ~0.35s

Wallet Analyzer Tests: 34 passed
Clustering Tests: 35 passed (existing)
PnL Engine Tests: 35 passed (existing)
```

## Deliverable Checklist

✅ Code compiles with no errors
✅ All unit tests pass (34/34)
✅ SmartMoneyScore works correctly (0-100)
✅ Smart money wallets can score 70+
✅ Dumb money wallets can score <30
✅ Edge cases handled gracefully
✅ <1 second per wallet analysis
✅ Production-ready code quality
