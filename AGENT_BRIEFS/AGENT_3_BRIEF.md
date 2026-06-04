# AGENT 3 BRIEF: Data Validation & Accuracy Testing

**Your Mission:** Validate that our smart money detection actually works. Be the quality assurance.

**You have 35 hours over 1 week. Deliverable due Friday 6pm ET.**

---

## TASKS (Complete all 5)

### Task 1: Smart Money Wallet Selection (6 hours)
**Identify 20 known profitable wallets on Solana**

1. Research on Solscan, Twitter, Discord communities
2. Look for:
   - Verified traders with public win records
   - Early Pump.fun winners
   - VC/founder wallets
   - Twitter traders with verified callouts
3. For each wallet, document:
   - Wallet address (public, verifiable)
   - Proof of "smartness" (tweet, public record, verified win)
   - Trading activity level (active vs dormant)

**Deliverable:** `VALIDATION_WALLETS_SMART.csv` with 20 wallets

---

### Task 2: Dumb Money Wallet Selection (6 hours)
**Identify 20 known loss-making wallets**

1. Look for wallets that:
   - Bought early in rugs that crashed 90%+
   - Bought near ATH and are underwater
   - FOMO buyers during market peaks
   - Known "retail FOMO" addresses
2. For each, document:
   - Wallet address
   - What went wrong (which rug? which peak?)
   - Current underwater percentage

**Deliverable:** `VALIDATION_WALLETS_DUMB.csv` with 20 wallets

---

### Task 3: Manual PnL Calculation (14 hours)
**Manually calculate PnL for all 40 wallets using Agent 1's methodology**

1. For each wallet:
   - Use Solscan to view all transactions
   - Extract: token bought, amount, price (approx from DEXScreener)
   - Extract: token sold, amount, price
   - Apply FIFO cost basis (Agent 1's algorithm)
   - Calculate: realized PnL, win rate, avg hold time
   
2. Spreadsheet format:
   ```
   Wallet | Token | Entry Price | Exit Price | Qty | PnL | Win/Loss | Hold Hours
   ```

3. Data sources:
   - Solscan for transactions
   - DEXScreener for historical prices
   - Manual verification on 5-10 trades per wallet

**Deliverable:** `VALIDATION_MANUAL_CALCULATIONS.xlsx` with all 40 wallets analyzed

---

### Task 4: Run Agent 6's Wallet Analyzer (6 hours)
**Score all 40 wallets using our SmartMoneyScore**

1. Run `WalletAnalyzer.analyze()` on each wallet
2. Collect scores for all 40
3. Compare smart money wallets vs dumb money wallets
4. Expected results:
   - Smart money: average score 70+
   - Dumb money: average score <30
   - Clear separation (>40 point difference)

**Deliverable:** `VALIDATION_ANALYZER_SCORES.xlsx` with all 40 scores

---

### Task 5: Calculate Accuracy Metrics (3 hours)
**Measure how well Agent 6's detector works**

1. Metrics to calculate:
   - **Precision:** % of wallets scored as "smart" that actually are smart
   - **Recall:** % of actual smart wallets that were scored as smart
   - **F1 Score:** Harmonic mean of precision & recall
   - **Accuracy:** % of all wallets correctly classified

2. Formula:
   ```
   Precision = TP / (TP + FP)
   Recall = TP / (TP + FN)
   F1 = 2 * (Precision * Recall) / (Precision + Recall)
   Accuracy = (TP + TN) / (TP + TN + FP + FN)
   ```
   
   Where TP/FP/FN = true/false positive/negative

3. Target:
   - Precision: 90%+
   - Recall: 85%+
   - F1: 87%+
   - Accuracy: 90%+

**Deliverable:** `VALIDATION_ACCURACY_REPORT.md` with all metrics

---

## DELIVERABLES BY FRIDAY 6PM ET

1. **VALIDATION_WALLETS_SMART.csv** (20 wallets with proof)
2. **VALIDATION_WALLETS_DUMB.csv** (20 wallets documented)
3. **VALIDATION_MANUAL_CALCULATIONS.xlsx** (40 wallets, manual PnL)
4. **VALIDATION_ANALYZER_SCORES.xlsx** (all 40 scores from Agent 6)
5. **VALIDATION_ACCURACY_REPORT.md** (precision/recall/F1/accuracy)

---

## SUCCESS CRITERIA

✅ All 40 wallets validated (20 smart, 20 dumb)
✅ Manual calculations use Agent 1's FIFO method correctly
✅ SmartMoneyScore separates smart from dumb (>40 point gap)
✅ Precision 90%+, Recall 85%+, F1 87%+
✅ Report includes confidence level and recommendations

---

## DEPENDENCIES & INTEGRATION

- **Uses:** Agent 1 (FIFO methodology), Agent 6 (WalletAnalyzer)
- **Feeds to:** Agent 9 (backtesting), Agent 10 (UI validation)
- **Required data:** Solscan API access, DEXScreener prices

---

## NOTES

- Be rigorous with manual calculations—this is our ground truth
- Document any discrepancies between manual & algorithm
- If accuracy <85%, investigate Agent 6 scoring formula
- Flag any edge cases (dormant wallets, airdrop anomalies, etc.)

This is validation work. Be thorough and honest about accuracy.

**Go make us confident this detector works.**
