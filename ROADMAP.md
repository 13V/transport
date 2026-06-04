# Feature & Improvement Roadmap

## Current State
✓ Basic 4-detector pipeline (creator, clusters, snipers, smart money)
✓ Single-token analysis
✓ Mobile-responsive UI
✓ Rate limiting & error handling
✗ No data export
✗ No historical tracking
✗ No external links/enrichment
✗ No risk scoring
✗ No search/discovery features

---

## High-Impact Features (Quick Wins)

### 1. External Links & Data Enrichment
**Why:** Users need context. Raw wallet addresses aren't useful without Solscan/DEXScreener.

**Implementation:**
```tsx
// In wallet display components:
<a href={`https://solscan.io/address/${wallet.address}`} target="_blank" rel="noopener">
  {formatAddress(wallet.address)} ↗
</a>
<a href={`https://birdeye.so/token/${mint}`} target="_blank">Chart ↗</a>
```

**Cost:** < 1 hour
**Value:** 5x increase in actionability

---

### 2. Risk Score & Summary Card
**Why:** Users want a quick "is this token sketchy?" answer.

**Implementation:**
```typescript
interface TokenRiskScore {
  score: number; // 0-100, higher = riskier
  factors: {
    creatorFunded: number; // % of supply held by creator cluster
    bundleActivity: number; // # of bundles in first slots
    whaleConcentration: number; // top 10 holders % of supply
    suspiciousPatterns: string[]; // ["Founder rug-ready", "Extreme whale concentration"]
  };
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
}
```

**Calc:**
- Extreme whale concentration (top 3 hold >50%): +30 pts
- Heavy creator cluster: +25 pts
- Multiple bundles in first blocks: +20 pts
- Very young creator wallet: +15 pts

**Display:** Giant badge at top of report ("⚠️ HIGH RISK - 78/100")

**Cost:** 2-3 hours
**Value:** Traders get actionable summary instantly

---

### 3. Copy-to-Clipboard & Quick Actions
**Why:** Users constantly copy/paste addresses.

**Implementation:**
```tsx
<button onClick={() => {
  navigator.clipboard.writeText(address);
  toast.success('Copied!');
}} title="Copy address">
  {formatAddress(address)} 📋
</button>
```

**Actions to add:**
- Copy wallet address
- Copy mint
- Share report (link with report data in URL or session)
- Export as JSON

**Cost:** 1 hour
**Value:** Smooth UX

---

### 4. Wallet Context Links
**Why:** Knowing a wallet's history is crucial.

Add buttons for each wallet:
- "View on Solscan"
- "View on Magic Eden" (if NFT holder)
- "Check history on DEXTools"
- "Show other tokens held" (would require new API call)

**Cost:** 1 hour (just URLs)
**Value:** Power user experience

---

### 5. Recent Searches & History
**Why:** Users re-analyze tokens, want quick access.

**Implementation:**
```typescript
// localStorage-based
useEffect(() => {
  const recent = JSON.parse(localStorage.getItem('recentTokens') || '[]');
  setRecentSearches(recent.slice(0, 10));
}, []);

// On search
const addRecent = (mint: string, name: string) => {
  const recent = [{ mint, name, timestamp: Date.now() }, ...oldRecent].slice(0, 10);
  localStorage.setItem('recentTokens', JSON.stringify(recent));
};
```

Display on home page: "Recently Analyzed"
- Shows thumbnails/names
- Quick click to re-run analysis

**Cost:** 2 hours
**Value:** Returns users' previous work instantly

---

## Medium-Impact Features (1-2 days)

### 6. Export Report as CSV/JSON
**Why:** Users want to save findings, cross-reference later.

**Implementation:**
```typescript
export function exportReport(report: TokenInsiderReport, format: 'csv' | 'json') {
  if (format === 'json') {
    downloadFile(JSON.stringify(report, null, 2), `${report.symbol}_${Date.now()}.json`, 'application/json');
  } else {
    // CSV: one row per holder, with cluster/bundle/pnl data
    const csv = convertReportToCsv(report);
    downloadFile(csv, `${report.symbol}_holders.csv`, 'text/csv');
  }
}
```

**Exports:**
- Full report (JSON)
- Holders list (CSV)
- Cluster members (CSV)
- Suspicious wallets (CSV for import to blocklists)

**Cost:** 3 hours
**Value:** Essential for serious traders

---

### 7. Wallet Timeline
**Why:** Understand when insiders bought.

**Feature:**
- Chart showing buy activity over time
- X-axis: time from launch
- Y-axis: cumulative wallets bought
- Color by: creator-funded (red), bundled (yellow), organic (green)

Uses `getTokenTransactions` data to show when each cluster/bundle acted.

**Cost:** 4 hours (need chart library)
**Value:** Pattern recognition tool

---

### 8. Whale Tracker
**Why:** Understand concentration risk.

**Show:**
- Top 10 holder addresses + %
- Cumulative % held by top N
- Distribution chart (pie: top 3, top 10, top 100, rest)
- Flag if any whale is creator-funded

**Calc:**
```typescript
const top3Pct = holders.slice(0, 3).reduce((sum, h) => sum + h.percentOfSupply, 0);
if (top3Pct > 0.5) {
  suspiciousPatterns.push(`🚨 Top 3 holders control ${(top3Pct*100).toFixed(1)}% of supply`);
}
```

**Cost:** 3 hours
**Value:** Rug pull detector

---

### 9. Creator Track Record
**Why:** Did this creator launch other tokens? Were they rugs?

**Requires:** Database of known creators/rugs (would need external data)

**Feature:**
- "This creator has launched 3 other tokens"
- Link to other analyses
- Flag if creator's previous tokens crashed >90%

**Data source:** Integrate with DEXScreener API to find other mints by creator

**Cost:** 4-5 hours (need API integration + caching)
**Value:** Historical context

---

## Ambitious Features (3+ days)

### 10. Comparative Token Analysis
**Why:** "Is this insider pattern similar to token X (which rugged)?"

**Feature:**
- Search for similar tokens
- Compare risk scores
- Show overlay: "similar creator patterns to TOKEN_X"

**Cost:** 5-7 hours
**Value:** Pattern matching for pump & dump detection

---

### 11. Wallet Connection Graph
**Why:** Visualize cluster relationships.

**Requires:** Graph visualization library (Cytoscape, D3, etc.)

**Show:**
- Nodes: wallets (sized by holdings)
- Edges: funding relationships
- Colors: creator (red), cluster (yellow), smart money (green)
- Interactive: click wallet to show details

**Cost:** 6-8 hours (need graph library + layout algorithms)
**Value:** Visual intuition

---

### 12. Real-Time Alerts
**Why:** "Alert me when new bundles appear on tokens I'm watching."

**Requires:** Background job, database, email/Discord notifications

**Feature:**
- Watch list (tokens to monitor)
- Conditions: "new bundle detected", "large buyer appears", "creator trades"
- Notifications: email / Discord webhook / in-app

**Cost:** 8-10 hours (need job queue + notifications)
**Value:** Early warning system

---

### 13. Cross-Token Smart Money Tracking
**Why:** "Show me which wallets from Token A are buying into Token B."

**Implementation:**
- For each smart money wallet, show their other recent trades
- Identify "consistent winners" who appear in multiple token launches
- Score: "This wallet has a 65% win rate across 12 tokens"

**Cost:** 6 hours (need cross-token indexing)
**Value:** True smart money identifier

---

## UX Improvements (Low Effort, High Impact)

### 14. Better Mobile Experience
**Current:** Responsive grid, but mobile still shows too much data

**Improvements:**
- Simplified mobile layout (tabs instead of all-at-once)
- Larger tap targets (min 44px)
- Hamburger menu for navigation
- Bottom sheet for details (instead of modal)

**Cost:** 2 hours
**Value:** Mobile traders need this

---

### 15. Dark Mode Toggle
**Current:** Always dark

**Add:**
- Light mode option (toggle in header)
- Persist to localStorage
- Use CSS custom properties for colors

**Cost:** 1 hour
**Value:** Some users prefer light mode

---

### 16. Keyboard Shortcuts
**Shortcuts to add:**
- `/` → focus search
- `?` → show help modal
- `c` → copy current address
- `e` → export report
- `↑/↓` → navigate wallet list

**Cost:** 2 hours
**Value:** Power user delight

---

### 17. Search Within Report
**Why:** 500-line report is hard to scan.

**Add:**
- Cmd+F / Ctrl+F equivalent
- Filter: by cluster, by bundle, by PnL
- Search specific wallet address

**Cost:** 2 hours
**Value:** Essential for large reports

---

### 18. Better Error Messages
**Current:** Generic "Analysis failed"

**Add:**
- Specific errors: "RPC timeout", "Token has no holders", "Helius rate limit"
- Retry buttons for transient errors
- Docs links for help

**Cost:** 1 hour
**Value:** Users can self-recover

---

## Data Integrity Improvements

### 19. Confidence Intervals
**Problem:** Numbers feel made up (heuristics)

**Solution:** Add confidence ranges:
```
Creator Probability: 78% (±15%)
Cluster Size: Small (2-5 wallets, high confidence)
Bundle Likely?: Yes (95% confidence)
```

**Cost:** 2 hours
**Value:** Users understand accuracy limits

---

### 20. Cache Strategy
**Problem:** Repeated analyses = repeated RPC costs

**Solution:**
- Client-side: cache reports in localStorage (24h)
- Server-side: Redis cache (opt-in with Vercel KV)
- Show "From cache (2h ago)" badge + "Refresh" button

**Cost:** 3-4 hours
**Value:** Saves 90% RPC costs for returning users

---

## High-Value Quick Wins (Do These First)

### Priority 1 (< 4 hours total)
1. External links (Solscan, DEXScreener, Birdeye)
2. Copy-to-clipboard buttons
3. Risk score badge
4. Recent searches (localStorage)
5. Better error messages

**Impact:** Turns "tech demo" into "usable tool"

### Priority 2 (next 1-2 days)
1. Export report (CSV/JSON)
2. Whale tracker section
3. Better mobile UX
4. Wallet timeline chart
5. Keyboard shortcuts

**Impact:** "Better than the alternative tools"

### Priority 3 (future, 3+ days)
1. Creator track record (needs external data)
2. Wallet connection graph (visualization)
3. Real-time alerts (infrastructure)
4. Cross-token tracking (complex)

---

## Suggested MVP++  Implementation Order

```
Week 1:
  Day 1: External links + copy + risk score (4h) → Deploy
  Day 2: Export + recent searches + error messages (4h) → Deploy
  Day 3: Whale tracker + timeline (4h) → Deploy

Week 2:
  Mobile UX + keyboard shortcuts + cache strategy (4h) → Deploy
  Confidence intervals (2h) → Deploy
  Bug fixes from user feedback

Week 3+:
  Creator track record (needs API integration)
  Graph visualization (UI intensive)
  Real-time alerts (infrastructure)
```

---

## Success Metrics

Track these to measure improvement:

- **Engagement:** Report views/day, export downloads, recent searches used
- **Retention:** Users who return within 7 days
- **Accuracy:** User feedback on risk scores (are they helpful?)
- **Performance:** Analysis time, cache hit rate
- **Satisfaction:** Would recommend this tool? (simple survey)

---

## Technical Debt to Address First

Before implementing new features, resolve these from the audit:

1. **Parse transaction data properly** (impacts all detectors)
2. **Fix N+1 RPC problem** (30s → 2s analysis)
3. **Fetch real token metadata** (wrong names showing)
4. **Add transaction instruction decoding** (enables PnL accuracy)

Once those are done, new features will work much better.

---

## Competitive Positioning

| Feature | Us (Current) | DEXTools | Birdeye | Proposed |
|---------|---|---|---|---|
| Creator detection | ✓ | ✗ | ✗ | ✓ |
| Cluster analysis | ✓ | Limited | Limited | ✓✓ |
| Bundle detection | ✓ | ✓ | ✓ | ✓ |
| Risk scoring | ✗ | ✓ | ✓ | ✓ |
| Export data | ✗ | ✓ | ✓ | ✓ |
| Whale tracking | ✗ | ✓ | ✓ | ✓ |
| Graph viz | ✗ | ✓ | ✓ | ~ |
| Open source | ✓ | ✗ | ✗ | ✓ |

After quick wins: we'll have parity on features + better creator/cluster detection.
