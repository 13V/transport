# FIFO_ALGORITHM.md - Cost Basis & Realized PnL Tracking

**Research Agent:** Agent 1 (Mathematician)
**Date:** June 4, 2026
**Status:** Research Complete

---

## Executive Summary

FIFO (First In, First Out) is the standard accounting method for calculating realized PnL in crypto trading. This document provides:

1. **Why FIFO is the standard for crypto**
2. **Complete FIFO algorithm with pseudocode**
3. **Real examples with step-by-step calculations**
4. **Edge cases and special handling**
5. **Python implementation**

**Key Finding:** FIFO assumes you sell your oldest tokens first. When you sell 1M tokens, you match them against your oldest buy lot until that lot is depleted, then move to the next lot.

---

## Part 1: Why FIFO For Crypto?

### Legal & Tax Considerations

1. **IRS Compliance:** FIFO is the default cost basis method for US tax purposes
2. **International Standard:** Most countries accept FIFO for crypto taxation
3. **Audit Trail:** FIFO is easiest to audit (chronological matching)
4. **Conservative:** FIFO often produces higher realized gains (sells older, cheaper lots first), which is preferred by regulators

### Alternatives (Not Used Here)

- **LIFO (Last In, First Out):** Assumes you sell newest tokens first. Tax disadvantage.
- **HIFO (Highest In, First Out):** Assumes you sell the highest-cost tokens first. Reduces taxes but harder to implement.
- **Average Cost:** Uses weighted average price. Less common in crypto.

---

## Part 2: FIFO Algorithm

### High-Level Overview

```
When you BUY tokens:
  Add them to a queue (FIFO "lots")
  Each lot stores: (amount, price, timestamp)

When you SELL tokens:
  Pop tokens from the front of the queue (oldest first)
  Calculate gain/loss for each lot
  Sum up realized PnL
  Remove depleted lots from queue
```

### Detailed Algorithm

```pseudocode
FIFO_Calculator:

INITIALIZE:
  cost_lots = []          // Queue of {amount, price_per_token, timestamp}
  realized_pnl = 0        // Running total realized profit/loss
  
PROCESS_TRADE(trade):
  IF trade.type == "BUY":
    new_lot = {
      amount: trade.tokens_received,
      price: trade.entry_price_per_token,
      timestamp: trade.timestamp,
      token_address: trade.token
    }
    cost_lots.append(new_lot)
    
  ELSE IF trade.type == "SELL":
    remaining_to_sell = trade.tokens_sold
    sale_price = trade.exit_price_per_token
    
    WHILE remaining_to_sell > 0 AND cost_lots is not empty:
      // Get the oldest lot
      current_lot = cost_lots[0]
      
      // How many tokens from this lot do we sell?
      tokens_from_this_lot = min(current_lot.amount, remaining_to_sell)
      
      // Calculate PnL for this lot
      cost_basis = tokens_from_this_lot * current_lot.price
      proceeds = tokens_from_this_lot * sale_price
      lot_pnl = proceeds - cost_basis
      
      // Add to total realized PnL
      realized_pnl += lot_pnl
      
      // Update lot and remaining
      current_lot.amount -= tokens_from_this_lot
      remaining_to_sell -= tokens_from_this_lot
      
      // If lot is depleted, remove it
      IF current_lot.amount == 0:
        cost_lots.remove(current_lot)
    
    // Error handling: if we tried to sell more than we own
    IF remaining_to_sell > 0:
      RAISE ERROR("Insufficient balance - selling more than owned")

RETURN realized_pnl
```

### Cost Basis Tracking

For each lot, we track:

```
lot = {
  'token_address': '...',
  'amount': 1000000,          // tokens in this lot
  'entry_price': 0.00199,     // SOL per token
  'cost_basis': 1990,         // total SOL spent (amount × entry_price)
  'purchase_date': '2024-01-15',
  'exchange': 'Raydium'
}
```

---

## Part 3: Real Example - Step by Step

### Scenario: Wallet with 5 Trades (ABC Token)

**Trade 1: Buy 1M ABC for 2 SOL**
```
Type: BUY
Token: ABC
Amount: 1,000,000
Price: 2 SOL / 1,000,000 = 0.000002 SOL per token
Entry value: 2 SOL
Date: 2024-01-10

Cost lots after:
  [
    {amount: 1000000, price: 0.000002, date: 2024-01-10, exchange: Raydium}
  ]
```

**Trade 2: Buy 500K ABC for 2 SOL**
```
Type: BUY
Token: ABC
Amount: 500,000
Price: 2 SOL / 500,000 = 0.000004 SOL per token (price went up)
Entry value: 2 SOL
Date: 2024-01-12

Cost lots after:
  [
    {amount: 1000000, price: 0.000002, date: 2024-01-10, exchange: Raydium},
    {amount: 500000,  price: 0.000004, date: 2024-01-12, exchange: Raydium}
  ]
```

**Trade 3: Buy 750K ABC for 3.75 SOL**
```
Type: BUY
Token: ABC
Amount: 750,000
Price: 3.75 SOL / 750,000 = 0.000005 SOL per token
Entry value: 3.75 SOL
Date: 2024-01-14

Cost lots after:
  [
    {amount: 1000000, price: 0.000002, date: 2024-01-10},
    {amount: 500000,  price: 0.000004, date: 2024-01-12},
    {amount: 750000,  price: 0.000005, date: 2024-01-14}
  ]

Total tokens owned: 2,250,000 ABC
Total cost basis: 2 + 2 + 3.75 = 7.75 SOL
```

**Trade 4: Sell 600K ABC for 0.00001 SOL per token**
```
Type: SELL
Token: ABC
Amount: 600,000
Exit Price: 0.00001 SOL per token
Exit value: 600,000 × 0.00001 = 6 SOL
Date: 2024-01-20

FIFO Matching:
  
  Lot 1: Sell 600K from the 1M (oldest lot at 0.000002)
    Cost basis: 600,000 × 0.000002 = 1.2 SOL
    Proceeds: 600,000 × 0.00001 = 6 SOL
    Gain: 6 - 1.2 = 4.8 SOL ✓ (Profitable)
    Lot 1 remaining: 1,000,000 - 600,000 = 400,000 tokens

Cost lots after:
  [
    {amount: 400000,  price: 0.000002, date: 2024-01-10},  // 400K remaining
    {amount: 500000,  price: 0.000004, date: 2024-01-12},  // untouched
    {amount: 750000,  price: 0.000005, date: 2024-01-14}   // untouched
  ]

Running realized PnL: +4.8 SOL
```

**Trade 5: Sell 1M ABC for 0.00008 SOL per token**
```
Type: SELL
Token: ABC
Amount: 1,000,000
Exit Price: 0.00008 SOL per token
Exit value: 1,000,000 × 0.00008 = 80 SOL
Date: 2024-01-25

FIFO Matching (need to sell 1M from remaining 1.65M):
  
  Lot 1 (remaining): 400,000 tokens at 0.000002
    Cost basis: 400,000 × 0.000002 = 0.8 SOL
    Proceeds: 400,000 × 0.00008 = 32 SOL
    Gain: 32 - 0.8 = 31.2 SOL ✓
    Lot 1 depleted, removed
    Remaining to sell: 1,000,000 - 400,000 = 600,000

  Lot 2: 600K from the 500K (2nd lot at 0.000004)
    Cost basis: 500,000 × 0.000004 = 2 SOL
    Proceeds: 500,000 × 0.00008 = 40 SOL
    Gain: 40 - 2 = 38 SOL ✓
    Lot 2 depleted, removed
    Remaining to sell: 600,000 - 500,000 = 100,000

  Lot 3: 100K from the 750K (3rd lot at 0.000005)
    Cost basis: 100,000 × 0.000005 = 0.5 SOL
    Proceeds: 100,000 × 0.00008 = 8 SOL
    Gain: 8 - 0.5 = 7.5 SOL ✓
    Lot 3 remaining: 750,000 - 100,000 = 650,000 tokens

Cost lots after:
  [
    {amount: 650000,  price: 0.000005, date: 2024-01-14}  // 650K remaining
  ]

Gain from Trade 5: 31.2 + 38 + 7.5 = 76.7 SOL
Running realized PnL: 4.8 + 76.7 = 81.5 SOL
```

### Summary

```
Total Trades: 5
Total Bought: 2,250,000 ABC for 7.75 SOL
Total Sold: 1,600,000 ABC for 86 SOL
Total Realized PnL: 81.5 SOL (PROFIT ✓)

Remaining Position: 650,000 ABC at cost basis of 3.25 SOL
Unrealized PnL: 650,000 × 0.00008 - 3.25 = 52 - 3.25 = 48.75 SOL

Return on investment (closed trades): 81.5 / 7.75 = 1052% return
Hold times:
  - Lot 1 (sold at trade 4): 2024-01-10 to 2024-01-20 = 10 days
  - Lot 1 (sold at trade 5): 2024-01-10 to 2024-01-25 = 15 days
  - Lot 2 (sold at trade 5): 2024-01-12 to 2024-01-25 = 13 days
  - Lot 3 (sold at trade 5): 2024-01-14 to 2024-01-25 = 11 days
  Average hold time: (10 + 15 + 13 + 11) / 4 = 12.25 days
```

---

## Part 4: Edge Cases

### Edge Case 1: Selling More Than You Own (Impossible on Spot)

**Problem:** Wallet shows 100 sells of 10M tokens each, but never had 100M tokens total.

**Solution:** This shouldn't happen on Solana spot trading (no shorting). If it does:
- Likely a data error (missing buy transactions)
- Check blockchain directly for all transfers
- Flag for manual review

### Edge Case 2: Partial Fills & Slippage

**Problem:** Transaction shows swap of "5 SOL" but actual received is 5% less due to slippage.

**Solution:**
- Use actual received amount from transaction, not input amount
- Solscan shows both: input and output
- Entry price = actual_sol_spent / actual_tokens_received

### Edge Case 3: Token Splits/Redenominations

**Problem:** ABC token does a 10:1 split, so 1M tokens becomes 10M tokens.

**Solution:**
- Adjust all cost lots by split ratio
- Update token amounts: multiply by 10
- Prices: divide by 10
- Total cost basis remains the same

### Edge Case 4: Bridged Tokens (USDC.e vs USDC)

**Problem:** Wallet has USDC.e on Solana that was bridged from Ethereum.

**Solution:**
- Track each version separately (different mint addresses)
- When bridging: cost basis carries over
- Price may differ slightly between versions

### Edge Case 5: Tokens Received From Airdrops

**Problem:** Wallet received 50M ABC tokens from airdrop (no purchase).

**Solution:**
- Cost basis for airdropped tokens = $0
- When sold, 100% of proceeds = realized gain
- Common case: airdrop gains are taxable as ordinary income at date of receipt

**Example:**
```
Airdrop received: 50M ABC (value at receipt: $10,000 on 2024-01-01)
Sold: 50M ABC for $50,000 on 2024-02-15

Realized PnL:
- Cost basis: $0
- Proceeds: $50,000
- Realized gain: $50,000
- Taxable gain: $10,000 (airdrop date) + $40,000 (price appreciation) = $50,000
```

### Edge Case 6: Multiple Sells Same Day

**Problem:** Wallet sold ABC token twice on the same day to two different addresses.

**Solution:**
- Process in order of transaction timestamp (or block position if same block)
- Each depletes lots in FIFO order
- Sum total realized PnL across both sells

### Edge Case 7: Decimal Precision

**Problem:** ABC token has 8 decimals, not 6. Numbers get very large.

**Solution:**
- Use Decimal type (Python) or BigInt (JavaScript)
- Never use floating point for crypto calculations
- Track actual on-chain amounts (with decimals), normalize at end

---

## Part 5: Python Implementation

```python
from dataclasses import dataclass, field
from typing import List, Dict, Optional
from datetime import datetime
from decimal import Decimal, getcontext
from enum import Enum

# High precision for crypto
getcontext().prec = 50

class TradeType(Enum):
    BUY = "buy"
    SELL = "sell"
    AIRDROP = "airdrop"

@dataclass
class CostLot:
    """Represents a single purchase lot for FIFO tracking"""
    token_address: str
    amount: Decimal  # Tokens in this lot
    entry_price: Decimal  # SOL (or other base) per token
    purchase_date: datetime
    exchange: str  # "Raydium", "Orca", "Pump", "Jupiter"
    transaction_hash: str
    
    @property
    def cost_basis(self) -> Decimal:
        """Total cost basis for this lot"""
        return self.amount * self.entry_price
    
    def sell(self, amount: Decimal, exit_price: Decimal) -> Decimal:
        """
        Sell from this lot and return PnL.
        
        Args:
            amount: Tokens to sell from this lot
            exit_price: Sale price per token
            
        Returns:
            Realized PnL (can be negative)
        """
        proceeds = amount * exit_price
        cost = amount * self.entry_price
        pnl = proceeds - cost
        return pnl

@dataclass
class Trade:
    """Represents a single buy/sell transaction"""
    trade_id: str
    trade_type: TradeType
    token_address: str
    token_symbol: str
    amount: Decimal  # Tokens involved
    price_per_token: Decimal  # In base currency (SOL/USDC/etc)
    timestamp: datetime
    exchange: str  # DEX name
    transaction_hash: str
    notes: Optional[str] = None

class FIFOCalculator:
    """
    Implements FIFO cost basis tracking and PnL calculation.
    
    Tracks cost lots for each token separately.
    Calculates realized PnL when tokens are sold.
    """
    
    def __init__(self):
        self.cost_lots: Dict[str, List[CostLot]] = {}  # token_addr -> [lots]
        self.realized_pnl: Dict[str, Decimal] = {}  # token_addr -> total PnL
        self.trades_processed: List[Trade] = []
    
    def process_trades(self, trades: List[Trade]) -> Dict:
        """
        Process a list of trades in chronological order.
        
        Args:
            trades: List of Trade objects sorted by timestamp
            
        Returns:
            Dictionary with PnL metrics
        """
        # Sort by timestamp to ensure FIFO ordering
        sorted_trades = sorted(trades, key=lambda t: t.timestamp)
        
        for trade in sorted_trades:
            self.process_trade(trade)
        
        return self.get_summary()
    
    def process_trade(self, trade: Trade) -> None:
        """Process a single trade"""
        if trade.token_address not in self.cost_lots:
            self.cost_lots[trade.token_address] = []
            self.realized_pnl[trade.token_address] = Decimal('0')
        
        if trade.trade_type == TradeType.BUY:
            self._process_buy(trade)
        elif trade.trade_type == TradeType.SELL:
            self._process_sell(trade)
        elif trade.trade_type == TradeType.AIRDROP:
            self._process_airdrop(trade)
        
        self.trades_processed.append(trade)
    
    def _process_buy(self, trade: Trade) -> None:
        """Add a new cost lot"""
        new_lot = CostLot(
            token_address=trade.token_address,
            amount=trade.amount,
            entry_price=trade.price_per_token,
            purchase_date=trade.timestamp,
            exchange=trade.exchange,
            transaction_hash=trade.transaction_hash
        )
        self.cost_lots[trade.token_address].append(new_lot)
    
    def _process_airdrop(self, trade: Trade) -> None:
        """Add a cost lot with zero cost basis"""
        new_lot = CostLot(
            token_address=trade.token_address,
            amount=trade.amount,
            entry_price=Decimal('0'),  # No cost for airdrop
            purchase_date=trade.timestamp,
            exchange="AIRDROP",
            transaction_hash=trade.transaction_hash
        )
        self.cost_lots[trade.token_address].append(new_lot)
    
    def _process_sell(self, trade: Trade) -> None:
        """Sell tokens using FIFO, calculate PnL"""
        token_addr = trade.token_address
        lots = self.cost_lots[token_addr]
        
        remaining_to_sell = trade.amount
        pnl_total = Decimal('0')
        
        while remaining_to_sell > 0 and lots:
            current_lot = lots[0]
            
            # How many tokens to sell from this lot?
            tokens_from_lot = min(current_lot.amount, remaining_to_sell)
            
            # Calculate PnL for this lot
            lot_pnl = current_lot.sell(tokens_from_lot, trade.price_per_token)
            pnl_total += lot_pnl
            
            # Update lot
            current_lot.amount -= tokens_from_lot
            remaining_to_sell -= tokens_from_lot
            
            # Remove depleted lot
            if current_lot.amount <= 0:
                lots.pop(0)
        
        # Check for error (sold more than owned)
        if remaining_to_sell > 0:
            raise ValueError(
                f"Tried to sell {remaining_to_sell} {trade.token_symbol} "
                f"but account was empty. Missing buy transactions?"
            )
        
        # Add to realized PnL
        self.realized_pnl[token_addr] += pnl_total
    
    def get_unrealized_pnl(self, token_address: str, current_price: Decimal) -> Decimal:
        """Calculate unrealized PnL for remaining position"""
        if token_address not in self.cost_lots:
            return Decimal('0')
        
        lots = self.cost_lots[token_address]
        total_amount = sum(lot.amount for lot in lots)
        total_cost_basis = sum(lot.cost_basis for lot in lots)
        current_value = total_amount * current_price
        
        return current_value - total_cost_basis
    
    def get_summary(self) -> Dict:
        """Get complete PnL summary"""
        summary = {}
        
        for token_addr, pnl in self.realized_pnl.items():
            # Find token symbol from trades
            symbol = next(
                (t.token_symbol for t in self.trades_processed 
                 if t.token_address == token_addr),
                "UNKNOWN"
            )
            
            # Calculate average hold time
            sells = [t for t in self.trades_processed 
                    if t.token_address == token_addr and t.trade_type == TradeType.SELL]
            buys = [t for t in self.trades_processed 
                   if t.token_address == token_addr and t.trade_type == TradeType.BUY]
            
            hold_times = []
            for sell in sells:
                for buy in buys:
                    if buy.timestamp < sell.timestamp:
                        hold_days = (sell.timestamp - buy.timestamp).days
                        if hold_days > 0:
                            hold_times.append(hold_days)
            
            avg_hold_days = sum(hold_times) / len(hold_times) if hold_times else 0
            
            summary[token_addr] = {
                'symbol': symbol,
                'realized_pnl': float(pnl),
                'num_buys': len(buys),
                'num_sells': len(sells),
                'avg_hold_days': avg_hold_days,
            }
        
        return summary


# Example usage
if __name__ == "__main__":
    # Create sample trades for ABC token
    trades = [
        Trade(
            trade_id="tx1",
            trade_type=TradeType.BUY,
            token_address="ABC_mint",
            token_symbol="ABC",
            amount=Decimal('1000000'),
            price_per_token=Decimal('0.000002'),
            timestamp=datetime(2024, 1, 10),
            exchange="Raydium",
            transaction_hash="hash1"
        ),
        Trade(
            trade_id="tx2",
            trade_type=TradeType.BUY,
            token_address="ABC_mint",
            token_symbol="ABC",
            amount=Decimal('500000'),
            price_per_token=Decimal('0.000004'),
            timestamp=datetime(2024, 1, 12),
            exchange="Raydium",
            transaction_hash="hash2"
        ),
        Trade(
            trade_id="tx3",
            trade_type=TradeType.BUY,
            token_address="ABC_mint",
            token_symbol="ABC",
            amount=Decimal('750000'),
            price_per_token=Decimal('0.000005'),
            timestamp=datetime(2024, 1, 14),
            exchange="Raydium",
            transaction_hash="hash3"
        ),
        Trade(
            trade_id="tx4",
            trade_type=TradeType.SELL,
            token_address="ABC_mint",
            token_symbol="ABC",
            amount=Decimal('600000'),
            price_per_token=Decimal('0.00001'),
            timestamp=datetime(2024, 1, 20),
            exchange="Raydium",
            transaction_hash="hash4"
        ),
        Trade(
            trade_id="tx5",
            trade_type=TradeType.SELL,
            token_address="ABC_mint",
            token_symbol="ABC",
            amount=Decimal('1000000'),
            price_per_token=Decimal('0.00008'),
            timestamp=datetime(2024, 1, 25),
            exchange="Raydium",
            transaction_hash="hash5"
        ),
    ]
    
    # Calculate PnL
    calc = FIFOCalculator()
    summary = calc.process_trades(trades)
    
    print("FIFO PnL Summary:")
    for token, metrics in summary.items():
        print(f"\n{metrics['symbol']}:")
        print(f"  Realized PnL: {metrics['realized_pnl']:.2f} SOL")
        print(f"  Trades: {metrics['num_buys']} buys, {metrics['num_sells']} sells")
        print(f"  Avg Hold: {metrics['avg_hold_days']:.1f} days")
```

---

## Part 6: Multi-Token Portfolios

### Tracking Multiple Tokens

Each token has its own FIFO lot queue. When calculating portfolio PnL:

```
Total Realized PnL = 
  Sum(PnL from token A) + 
  Sum(PnL from token B) + 
  Sum(PnL from token C) + 
  ... etc
```

### Example: 3-Token Portfolio

```
Token ABC:
  Realized PnL: +81.5 SOL

Token XYZ:
  Realized PnL: -10 SOL (loss)

Token DEF:
  Realized PnL: +25 SOL

Portfolio Realized PnL: 81.5 - 10 + 25 = +96.5 SOL
```

---

## Part 7: Validation Against Manual Calculation

### Methodology

1. **Pick a wallet with 20+ trades**
2. **Manually calculate each trade:**
   - FIFO matching step by step
   - Track cost lots
   - Calculate PnL per lot
3. **Compare vs algorithm output**
4. **Verify match (should be 100% exact)**

### Test Case Results (To be completed in VALIDATION_RESULTS.md)

---

## References & Sources

- [Crypto Tax Accounting Methods: FIFO, LIFO, HIFO](https://www.ledger.com/academy/crypto-tax-accounting-methods-fifo-lifo-hifo-explained) - Official explanation
- [What is PnL in Crypto](https://www.gate.com/crypto-wiki/article/what-is-profit-and-loss-pnl-and-how-is-it-calculated-20260106) - Gate.io explanation
- [Crypto PnL Calculator Guide](https://www.walletfinder.ai/blog/crypto-pnl-calculator) - Implementation guide
- [How to Calculate Cost Basis](https://koinly.io/blog/calculate-cost-basis-crypto-bitcoin/) - Koinly reference

---

## Deliverable Checklist

- [x] FIFO algorithm explained
- [x] Pseudocode provided
- [x] Real example with 5 trades
- [x] Edge cases documented (7 cases)
- [x] Python implementation with code
- [x] Multi-token portfolio handling
- [x] Manual validation methodology
- [x] Sources cited

**Status: READY FOR AGENT 2 IMPLEMENTATION**
