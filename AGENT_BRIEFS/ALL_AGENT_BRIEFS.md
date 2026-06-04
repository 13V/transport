
## Agent 3: Data Validation & Accuracy Testing

**Mission:** Validate that our PnL calculation and smart money detection actually works. Be the quality assurance.

**Your Tasks:**
1. Identify 20 known smart money wallets (profitable track record)
2. Identify 20 known dumb money wallets (lost money on rugs)
3. Manually calculate PnL for all 40 wallets (use Agent 1's methodology)
4. Test if Agent 2's smart money definition correctly identifies the profitable wallets
5. Run accuracy metrics: precision, recall, F1 score
6. Report: "Our detector is X% accurate at identifying smart money"

**Deliverable by Friday:**
- VALIDATION_REPORT.md (40 wallets tested, accuracy scores, confidence level)

---

## Agent 4: Market Research & Pricing Validation

**Mission:** Confirm there's a real market. Will traders use it?

**Your Tasks:**
1. Survey 20 Solana traders about smart money detection
2. Calculate TAM (Total Addressable Market)
3. Research competitive pricing
4. Calculate revenue potential

**Deliverable by Friday:**
- MARKET_RESEARCH.md (surveys, TAM, pricing recommendation)

---

## Agent 5: PnL Calculation Engine

**Mission:** Build bulletproof PnL calculation using Agent 1's methodology.

**Your Tasks:**
1. Implement bonding curve math
2. Implement AMM swap tracking
3. Implement FIFO cost basis
4. Implement portfolio aggregation
5. Test against all Agent 1's examples

**Deliverable by Friday:**
- lib/pnl-engine.ts (production code, unit tests)
- All 10 test cases pass

---

## Agent 6: Wallet Analyzer

**Mission:** Score wallets by trading skill. This ranks smart money.

**Your Tasks:**
1. Build WalletAnalyzer class (using PnL engine)
2. Calculate: PnL, win rate, consistency, timing
3. Create scoring formula (0-100)
4. Test: Smart money scores 70+, dumb money <30
5. Detect trading patterns (scalper vs swing vs HODL)

**Deliverable by Friday:**
- lib/wallet-analyzer.ts (production code, unit tests)
- Score validation results

---

## Agent 7: Data Ingestion & Optimization

**Mission:** Get data fast. Analysis must run in <2 seconds.

**Your Tasks:**
1. Optimize Helius API (batch calls, cache results)
2. Build efficient data fetching
3. Implement caching layer (24h TTL)
4. Performance benchmarking
5. Error handling & fallbacks

**Deliverable by Friday:**
- lib/helius-optimized.ts (fast, cached, efficient)
- Performance test: "Top 100 holders in <2 seconds"

---

## Agent 8: Smart Money Ranker

**Mission:** Build live leaderboard of top 100 smart money wallets.

**Your Tasks:**
1. Build ranker algorithm
2. Aggregate wallets across all tokens
3. Create leaderboard (top 100, ranked by PnL)
4. Store historical snapshots (daily)
5. Build API endpoints

**Deliverable by Friday:**
- Smart money ranker code
- Leaderboard UI showing top 100
- API: /api/smart-money, /api/smart-money/{wallet}

---

## Agent 9: Trader Feedback & Validation

**Mission:** Prove this works with real traders.

**Your Tasks:**
1. Recruit 20 test traders
2. Backtest: "If you followed wallet X 30 days ago, you'd have +Y%"
3. Create 10 detailed case studies
4. Survey traders: "Would you use this? Pay for it?"
5. Measure: Do following smart money beat market?

**Deliverable by Friday:**
- VALIDATION_RESULTS.md (backtests, case studies, survey)
- Proof: "Following smart money beats market by 50%"

---

## Agent 10: UI/UX Polish

**Mission:** Make the smartest money detector beautiful and fast.

**Your Tasks:**
1. Design leaderboard UI (wallet, PnL, win rate, latest trade)
2. Design wallet detail view (trade history, chart, metrics)
3. Optimize for speed (<1s page load)
4. Mobile responsiveness
5. Accessibility (colors, labels, keyboard nav)

**Deliverable by Friday:**
- Figma designs (leaderboard, detail view, homepage)
- React components (fully built)
- Performance test: "<1 second load"
- Mobile tested: "Works great on iPhone"

---

## Week 3 Success Metrics

✅ PnL calculation 95%+ accurate  
✅ Smart money wallets identified (40 validated)  
✅ Leaderboard live with top 100 wallets  
✅ Analysis runs in <2 seconds  
✅ Backtests show +50% market outperformance  
✅ 20 traders tested, positive feedback  
✅ UI beautiful and fast (<1s load)  
✅ Code deployed, domain live, ready to launch  

---

## Go Build This

Each agent has their mission. Friday reviews at 4pm ET.

This is not a SaaS. This is one thing: Find smart money wallets. Show traders. Let them profit.

Do it perfectly.
