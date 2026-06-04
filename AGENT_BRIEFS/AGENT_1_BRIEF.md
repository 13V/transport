# AGENT 1 BRIEF: PnL Calculation Methodology

**Your Mission:** Research and document how to calculate realized PnL accurately on Solana. This is foundational—everything else depends on it.

**Your Role:** You are the mathematician of the team. By Friday EOD, the technical pod needs to know exactly how to calculate returns.

---

## Tasks

### Task 1: Bonding Curve Math (Pump.fun)
**Research Time: 8 hours**

1. Study Pump.fun bonding curve formula
   - Current formula: y = 1073000191 - 32190005730/(30+x)
   - Where y = tokens, x = SOL spent
   
2. Reverse engineer: Given tokens sold and tokens received, calculate:
   - Entry price per token (SOL per token)
   - Current market price
   - Realized gain/loss if sold at price X

3. Test with real data:
   - Find a Pump.fun token that graduated to Raydium
   - Pick 5 wallets that bought on bonding curve
   - Manually calculate their PnL
   - Verify formula accuracy

4. Document:
   - Bonding curve equation with explanation
   - Entry price calculation
   - Exit price calculation
   - Real example (wallet X bought 10k tokens for 5 SOL, now worth 50 SOL, gain = $225)

**Deliverable:** `BONDING_CURVE_MATH.md` with formula, code snippet, and 3 real examples

---

### Task 2: AMM Swap Tracking (Raydium/Orca/Jupiter)
**Research Time: 10 hours**

1. Understand how to extract swap information from transactions
   - Which instructions to look for (Raydium program ID, etc.)
   - How to parse token in/token out amounts
   - How to extract prices from swap size

2. Research each DEX:
   - **Raydium:** How to calculate price per token from swap size
   - **Orca:** Same, but different math (constant product formula)
   - **Jupiter:** Aggregates both, but still calculable

3. Get sample swaps from blockchain:
   - Find 10 real swaps on Raydium (use Solscan API or Helius)
   - For each swap, extract: token in, amount in, token out, amount out
   - Calculate: price per token at swap time

4. Verify accuracy:
   - Compare your calculation vs DEXScreener price at that time
   - Should be within 1% (slippage accounts for difference)

5. Document:
   - How to parse swap instructions
   - Price calculation per DEX
   - Real examples with code

**Deliverable:** `AMM_SWAP_MATH.md` with parsing code and 5 real swap examples

---

### Task 3: FIFO Cost Basis Tracking
**Research Time: 8 hours**

1. Understand FIFO (First In, First Out) method
   - Why it's the standard for crypto
   - How it works: match sells against oldest buys first
   - Why this matters for accurate PnL

2. Algorithm:
   ```
   costBasis = []  // ordered list of {amount, price, date}
   realizedPnL = 0
   
   for each trade:
     if BUY: costBasis.append({amount, price, date})
     if SELL:
       remaining = amount
       while remaining > 0:
         lot = costBasis[0]
         lotSize = min(lot.amount, remaining)
         gain = (salePrice - lot.price) * lotSize
         realizedPnL += gain
         remaining -= lotSize
         lot.amount -= lotSize
         if lot.amount == 0: costBasis.pop(0)
   ```

3. Test with real data:
   - Pick a wallet with 20+ trades
   - Manually calculate FIFO PnL
   - Verify logic

4. Consider edge cases:
   - Partial sells (sell 50 of 100 tokens)
   - Multiple buys at different prices
   - Hold period (long-term vs short-term—not needed for crypto, but track it)

**Deliverable:** `FIFO_ALGORITHM.md` with pseudocode, real example, edge cases

---

### Task 4: Cross-Token Portfolio PnL
**Research Time: 6 hours**

1. How to calculate PnL across multiple tokens
   - Sum realized PnL from all tokens (easy)
   - Calculate portfolio PnL % (realized gains / initial investment)
   - Handle denominator (what's the baseline for comparison?)

2. Timing:
   - When did the wallet start trading? (first buy timestamp)
   - How many days of trading history? (measure consistency over time)
   - Example: wallet with $10k invested over 90 days earned $15k = +150% PnL

3. Consistency metrics:
   - Win rate: % of trades that were profitable (target: 50%+)
   - Average hold time: days between buy and sell (informs trading style)
   - Biggest win vs biggest loss (risk/reward ratio)

**Deliverable:** `PORTFOLIO_PNL.md` with formulas and real wallet example

---

### Task 5: Validation Against Manual Data
**Research Time: 8 hours**

1. Pick 5 real Solana wallets known to be profitable
   - Find on Twitter/Discord (influencers who've called wins)
   - Use Solscan to manually track their trades
   - Manually calculate their PnL

2. For each wallet:
   - List every buy (token, amount, price, date)
   - List every sell (token, amount, price, date)
   - Calculate PnL using your formula
   - Compare vs manual calculation
   - Should be within 1-2% (only rounding differences)

3. Test on known loss-makers:
   - Pick 5 wallets that are clearly unprofitable
   - Verify your formula correctly shows negative returns

4. Document findings:
   - Accuracy score: % of wallets where formula matched manual (target: 100%)
   - Any discrepancies and why

**Deliverable:** `VALIDATION_RESULTS.md` with 10 wallet analyses

---

## Resources You Need

- Solscan (free, view transactions)
- Helius API docs (understand transaction structure)
- DEXScreener API (historical prices)
- Calculator (for manual verification)
- Your brain (math is required)

---

## Deliverables Due Friday 6pm ET

1. **BONDING_CURVE_MATH.md** (formula, examples, code)
2. **AMM_SWAP_MATH.md** (parsing, calculations, examples)
3. **FIFO_ALGORITHM.md** (algorithm, pseudocode, edge cases)
4. **PORTFOLIO_PNL.md** (formulas, consistency metrics)
5. **VALIDATION_RESULTS.md** (10 wallets verified)

**Total:** ~40 hours of research, ~15 pages of documentation

---

## Success Criteria

- [ ] All formulas are mathematically correct (can be audited)
- [ ] All calculations verified against manual data (95%+ accuracy)
- [ ] Code examples are implementable (Agent 5 can use directly)
- [ ] Real examples show the methodology works
- [ ] No ambiguities (Agent 5 knows exactly what to build)

---

## Friday Review

**You'll present:**
- Summary of methodology
- Key insights (what makes accurate PnL calculation hard on Solana)
- Confidence level: "I'm X% confident this will give us 95%+ accuracy"
- Any unknowns or concerns

**Team will ask:**
- "Can Agent 5 implement this in code?"
- "Are there edge cases we're missing?"
- "Does this work for all token types?"

---

## Questions?

Post in #agent-1-research (Slack) anytime. 

**Go make us confident we can build this. You're the mathematician on this team.**
