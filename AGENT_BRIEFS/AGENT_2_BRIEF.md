# AGENT 2 BRIEF: Smart Money Research & Definition

**Your Mission:** Define what "smart money" actually is on Solana and validate that it exists. By Friday, we need to know: What makes a wallet smart? Can we identify them reliably?

**Your Role:** You are the market researcher. You talk to real traders, study their behavior, and tell us what patterns define winners.

---

## Tasks

### Task 1: Smart Money Definition Research
**Research Time: 12 hours**

1. Study smart money in traditional finance
   - What do hedge funds, VCs, and institutional traders have in common?
   - How do they identify opportunities others miss?
   - Key trait: **Consistent edge** (beat market repeatedly, not luck)

2. Crypto smart money:
   - Research: What's different on Solana vs Bitcoin/ETH?
   - Early access? (presales, insider networks)
   - Technical analysis? (chart reading)
   - On-chain signals? (large holder tracking)
   - Community? (discord/Twitter intel first)

3. Interview 5-10 power traders (Discord, Twitter DMs)
   - "How do you identify who the smart money is?"
   - "Who do you follow?"
   - "What's their track record?"
   - "What makes them different from random traders?"

4. Define smart money operationally
   - NOT: "They got lucky once"
   - YES: "50%+ win rate across 10+ trades, <90 days, all-time positive PnL"
   - Edge must be provable and repeatable

**Deliverable:** `SMART_MONEY_DEFINITION.md` (with trader quotes, 3 different definitions tested)

---

### Task 2: Case Study Deep Dives
**Research Time: 14 hours**

1. Find 10 known "smart money" wallets on Solana
   - Look for influencers, VCs, early traders who've called wins
   - Examples to search:
     - Early Pump.fun winners (who got in first week, exited at peak)
     - Token project founders/investors (they know when to exit)
     - Twitter traders with verified win callouts
     - Discord communities known for finding 10x tokens
   
2. For each wallet, document:
   - Wallet address
   - How we know they're "smart" (proof: tweet callout, verified win, etc.)
   - Sample trades (5-10 recent trades showing pattern)
   - Entry/exit prices (approximate from Solscan)
   - Estimated PnL (rough calculation)
   - Trading style (scalping? swing? launch catching?)

3. Find 5 known "dumb money" wallets for comparison
   - Early buyers of tokens that crashed 90%+
   - People who bought near ATH and are underwater
   - Known rugs that people fell for

4. Compare the two groups
   - What's different about smart money vs dumb money?
   - Timing? (enter early, exit early)
   - Diversification? (spread bets vs all-in)
   - Risk? (position sizing)

**Deliverable:** `SMART_MONEY_CASE_STUDIES.md` (10 detailed wallets with analysis)

---

### Task 3: Pattern Recognition
**Research Time: 8 hours**

1. Across all 10 smart money wallets, identify common patterns:
   - **Timing:** Do they buy early and sell early? (before hype)
   - **Diversification:** How many tokens do they hold? (1 vs 10 vs 100)
   - **Hold time:** Days between buy and sell? (scalping vs swing trading)
   - **Risk sizing:** How much do they invest per trade?
   - **Community:** Are they in early Discord communities?

2. Hypothesis: Smart money has edge because of:
   - [ ] Insider access (presales)
   - [ ] Technical analysis (chart reading)
   - [ ] Community intel (first to know about tokens)
   - [ ] Scale (larger wallets get filled first)
   - [ ] Risk management (sell before rug)
   - [ ] Diversification (beat odds with volume)

3. For each pattern, find evidence:
   - Example 1: "Smart wallet X entered launch within 1 minute" (suggests insider/bot)
   - Example 2: "Smart wallet Y diversified across 50 tokens, 40 hit 2x+" (suggests skill)
   - Example 3: "Smart wallet Z has 70% win rate—statistical edge" (skill vs luck)

**Deliverable:** `SMART_MONEY_PATTERNS.md` (what makes them win)

---

### Task 4: Validate Smart Money Identification
**Research Time: 10 hours**

1. Test: "Can we identify smart money wallets by looking at their trades?"
   - Take 10 smart money wallets (from Task 2)
   - Strip identifying info
   - Look only at: trade history, PnL, win rate, timing
   - Can you tell they're "smart" without knowing in advance?

2. Create a simple heuristic:
   ```
   smartness_score = (realizedPnL * 0.4) 
                   + (winRate * 0.3) 
                   + (consistency * 0.2)
                   + (timing_edge * 0.1)
   ```
   - Apply to all 10 wallets
   - Do the known smart money score high?
   - Do the known dumb money score low?

3. Sensitivity analysis:
   - What if we change weights? (more emphasis on win rate vs PnL)
   - Does smart money still score high?
   - Is the signal robust?

4. Feasibility check:
   - Can Agent 5-8 measure these signals in code?
   - Or are some signals unmeasurable? (community intel = hard to automate)

**Deliverable:** `SMART_MONEY_IDENTIFICATION.md` (how to spot them, validation results)

---

### Task 5: Competitive Analysis
**Research Time: 6 hours**

1. Research existing smart money tools
   - Santiment (smart contracts wallet tracking)
   - IntoTheBlock (whale tracking)
   - Lookonchain (on-chain analysis)
   - What do they offer? What's missing?

2. Why don't they work for Solana?
   - Too slow? Too expensive? Wrong heuristics?
   - What's our advantage?

3. Research Solana-specific tools:
   - Magic Eden (holder tracking)
   - Birdeye (portfolio tracking)
   - What do they show? Can we differentiate?

**Deliverable:** `COMPETITIVE_ANALYSIS.md` (what we do better)

---

## Resources You Need

- Solscan (free, view wallets + transactions)
- Twitter/Discord (find traders to interview)
- Google Sheets (document case studies)
- Your network (crypto Twitter contacts)

---

## Deliverables Due Friday 6pm ET

1. **SMART_MONEY_DEFINITION.md** (definition + trader interviews)
2. **SMART_MONEY_CASE_STUDIES.md** (10 wallets in detail)
3. **SMART_MONEY_PATTERNS.md** (common behaviors)
4. **SMART_MONEY_IDENTIFICATION.md** (how to identify, validation)
5. **COMPETITIVE_ANALYSIS.md** (what we do differently)

**Total:** ~50 hours research, ~20 pages documentation

---

## Success Criteria

- [ ] Can explain what "smart money" is to a trader (they agree with definition)
- [ ] Can point to 10 real examples of smart money wallets
- [ ] Can identify a pattern that separates smart from dumb money
- [ ] Identified a measurable heuristic that works 80%+ of the time
- [ ] No hand-wavy definitions (everything grounded in data)

---

## Friday Review

**You'll present:**
- "Smart money is defined as: [X]"
- "Here are 10 examples with proof"
- "They have these patterns in common"
- "We can identify them with [heuristic] with 80%+ accuracy"
- Confidence: "This definition will hold up when Agent 3 validates it"

**Team will ask:**
- "Would traders agree with this definition?"
- "Are the patterns strong enough to detect reliably?"
- "What about false positives/negatives?"

---

## Questions?

Post in #agent-2-research (Slack).

**You're defining who we're tracking. Make sure it's real.**
