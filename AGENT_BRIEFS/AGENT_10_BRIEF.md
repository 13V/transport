# AGENT 10 BRIEF: UI/UX Polish & Launch Readiness

**Your Mission:** Make the smartest money detector beautiful and fast.

**You have 40 hours over 1 week. Deliverable due Friday 6pm ET.**

---

## TASKS (Complete all 5)

### Task 1: Leaderboard UI (12 hours)
**Design and build the main leaderboard view**

1. Leaderboard features:
   - Top 100 smart money wallets displayed
   - Columns: Rank, Wallet Address, SmartMoneyScore, PnL, Win Rate, Latest Trade
   - Search: find wallet by address
   - Sort: by score, PnL, activity date
   - Pagination: 10, 25, 50 wallets per page
   - Live updates: refresh every 5 minutes

2. Design (mobile-first):
   - Clean, minimal layout
   - Color-coded scores (red <30, yellow 30-70, green 70+)
   - Copy-to-clipboard for wallet addresses
   - Links to Solscan, DEXScreener
   - Loading states & skeleton loaders

3. UX requirements:
   - Click any wallet → detail view
   - Hover → shows full address tooltip
   - Mobile: touch-friendly, no hover effects
   - Accessibility: ARIA labels, keyboard nav

4. Technical:
   - React components (existing Next.js setup)
   - Fetch from Agent 8's API
   - Real-time updates (websocket or polling)
   - Fast load: <1 second

**Deliverable:** `app/components/SmartMoneyLeaderboard.tsx` + styles

---

### Task 2: Wallet Detail View (12 hours)
**Design and build detailed wallet analysis page**

1. Wallet detail features:
   - Header: wallet address, SmartMoneyScore, percentile
   - Stats: realized PnL, win rate, consistency, timing
   - Trading style: "Scalper" / "Swing Trader" / "Early Buyer"
   - Risk assessment: Low / Medium / High
   - Current holdings: list of tokens with quantities & unrealized PnL
   - Trade history: table of recent trades (last 50)

2. Trade history columns:
   - Token (with icon)
   - Type (BUY / SELL)
   - Amount
   - Price (SOL/token)
   - Profit/Loss
   - Timestamp
   - Link to transaction on Solscan

3. Charts:
   - PnL over time (30-day chart)
   - Win rate trend
   - Ranking position over time (Agent 8 provides history)

4. Mobile: collapse sections, horizontal scroll for tables

5. Technical:
   - Fetch from Agent 8's `/api/smart-money/{wallet}` endpoint
   - Recharts for charts
   - Tables with sorting & filtering
   - <1 second load time

**Deliverable:** `app/components/WalletDetail.tsx` + styles

---

### Task 3: Search & Discovery (8 hours)
**Build search and discovery features**

1. Search functionality:
   - Search by wallet address
   - Autocomplete: suggests wallets as you type
   - Results: show matching wallets with score
   - Recent searches: remember last 5 searches

2. Discovery features:
   - "Browse by trading style" (scalpers, swing traders, early buyers)
   - "Top gainers this week"
   - "Most consistent performers"
   - "New to top 100"
   - Filters: by trading style, score range, PnL range

3. Technical:
   - Debounced search (300ms)
   - Index wallets for fast autocomplete
   - Filters sent to Agent 8's API

**Deliverable:** `app/components/SearchBar.tsx` + `app/components/Discovery.tsx`

---

### Task 4: Performance Optimization (6 hours)
**Ensure <1 second page load**

1. Optimization targets:
   - First contentful paint (FCP): <1 second
   - Largest contentful paint (LCP): <1.5 seconds
   - Time to interactive (TTI): <2 seconds

2. Techniques:
   - Code splitting: lazy load detail view
   - Image optimization: use WebP, next/image
   - Caching: browser cache leaderboard for 5 min
   - Compression: gzip assets
   - Minimize JS: tree-shake unused code

3. Monitoring:
   - Lighthouse score: 85+
   - Core Web Vitals: all green
   - Real user monitoring (RUM): track performance in production

**Deliverable:** Performance report + optimizations applied

---

### Task 5: Mobile Responsiveness & Accessibility (2 hours)
**Ensure works great on phones and is accessible**

1. Mobile testing:
   - iPhone 12, 14 (Safari)
   - Android phones (Chrome)
   - Tablet sizes (iPad, Samsung Tab)
   - Touch interactions: no hover, swipe-friendly

2. Accessibility (WCAG 2.1 AA):
   - Color contrast: 4.5:1 minimum
   - Font sizes: minimum 16px on mobile
   - ARIA labels on buttons
   - Keyboard navigation: Tab through all interactive elements
   - Screen reader tested

3. Features for accessibility:
   - High contrast mode support
   - Adjustable text size
   - Focus indicators on all buttons

**Deliverable:** Accessibility audit report + fixes applied

---

## DELIVERABLES BY FRIDAY 6PM ET

1. **app/components/SmartMoneyLeaderboard.tsx** (main leaderboard view)
2. **app/components/WalletDetail.tsx** (detailed wallet analysis)
3. **app/components/SearchBar.tsx** + **Discovery.tsx** (search & discovery)
4. **app/styles/** (complete styling with Tailwind)
5. **PERFORMANCE_REPORT.md** (Lighthouse scores, optimization summary)
6. **app/pages/** (route setup for leaderboard, detail views)

---

## SUCCESS CRITERIA

✅ Leaderboard UI loads in <1 second
✅ Detail view loads in <1 second
✅ Mobile responsive (tested on 3+ devices)
✅ Accessibility: WCAG 2.1 AA compliant
✅ Lighthouse score 85+
✅ Beautiful & intuitive (traders want to use it)

---

## DESIGN PRINCIPLES

- **Fast:** Users don't wait
- **Clear:** Easy to find smart money wallets
- **Trustworthy:** Show data transparently (real addresses, real scores)
- **Mobile-first:** Most traders use phones
- **Minimal:** No clutter, focus on essentials

---

## BRANDING & POLISH

- Color scheme: professional, crypto-friendly (dark mode?)
- Typography: clean, readable
- Icons: consistent with Solana ecosystem
- Tone: helpful, not hype

---

## TESTING CHECKLIST

- [ ] Load leaderboard, click wallet → detail view works
- [ ] Search for address → autocomplete works
- [ ] Charts render correctly
- [ ] Mobile: leaderboard readable on iPhone 12
- [ ] Mobile: tap wallet → detail view on phone
- [ ] Accessibility: Tab through all elements
- [ ] Performance: Lighthouse 85+
- [ ] Links: Solscan, DEXScreener all working

---

## DEPLOYMENT

- Build: `npm run build` (no errors)
- Preview: `npm run dev` (test locally)
- Deploy: Vercel (Agent 10 handles)
- Domain: insidertracker.ai (purchased & configured)
- SSL: automatic via Vercel

---

## NOTES

- UI is the face of the product. Make it count.
- Traders are your users. Watch for confusion/frustration.
- Speed is a feature (Agent 7 optimization is critical)
- Mobile is primary (most users are on phones)
- Feedback from Agent 9 (user testing) informs final polish

This is what users see. Make it beautiful.

**Go make world-class UI.**
