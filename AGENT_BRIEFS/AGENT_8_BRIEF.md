# AGENT 8 BRIEF: Smart Money Ranker

**Your Mission:** Build live leaderboard of top 100 smart money wallets.

**You have 40 hours over 1 week. Deliverable due Friday 6pm ET.**

---

## TASKS (Complete all 5)

### Task 1: Ranker Algorithm (10 hours)
**Build algorithm to rank smart money wallets across all tokens**

1. Input: Thousands of wallets across many tokens
   
2. Metrics to aggregate:
   - SmartMoneyScore (from Agent 6): 0-100
   - PnL across all tokens (from Agent 5): total realized gains
   - Win rate (from Agent 6): % profitable trades
   - Consistency (from Agent 6): stability metric
   - Timing score (from Agent 6): entry quality

3. Ranking formula:
   ```
   RankScore = (SmartMoneyScore × 0.5) + 
               (normalizedPnL × 0.2) + 
               (winRate × 100 × 0.15) + 
               (consistency × 0.15)
   
   Final rank: Sort by RankScore, ascending order
   ```

4. Requirements:
   - Deduplication: same wallet address = same rank
   - Cross-token aggregation: sum PnL across all tokens held
   - Recency: prioritize recent activity
   - Confidence filtering: exclude low-data wallets

**Deliverable:** `lib/smart-money-ranker.ts` with ranking algorithm

---

### Task 2: Leaderboard Data Pipeline (10 hours)
**Pipeline to populate and update leaderboard**

1. Data sources:
   - Solscan for all token transfer history
   - Helius API for transaction data
   - Our database for SmartMoneyScore cache

2. Pipeline steps:
   ```
   Step 1: Fetch top 200 tokens by volume
   Step 2: For each token, get top 100 holders
   Step 3: Analyze each unique wallet (deduplicate)
   Step 4: Calculate RankScore for each
   Step 5: Sort and select top 100
   Step 6: Store snapshot (daily historical)
   ```

3. Batch processing:
   - Run daily at 2 AM UTC
   - Update real-time when new smart money detected
   - Handle partial failures gracefully

4. Database schema:
   ```sql
   smart_money_leaderboard:
   - id (uuid)
   - rank (1-100)
   - wallet_address (string)
   - score (0-100)
   - pnl (float)
   - win_rate (0-1)
   - tokens_held (int)
   - updated_at (timestamp)
   - snapshot_date (date)
   
   leaderboard_history:
   - wallet_address
   - rank (historical rank on this date)
   - snapshot_date (date)
   ```

**Deliverable:** `lib/leaderboard-pipeline.ts` with data pipeline and schema

---

### Task 3: REST API Endpoints (12 hours)
**Build API endpoints to serve leaderboard data**

1. Endpoints to implement:

   **GET /api/smart-money**
   - Returns top 100 leaderboard
   - Query params: limit (1-100), offset (pagination)
   - Response: array of ranked wallets
   ```json
   {
     "leaderboard": [
       {
         "rank": 1,
         "address": "abc123...",
         "score": 92,
         "pnl": 50000,
         "winRate": 0.72,
         "tokensHeld": 12,
         "updatedAt": "2026-06-04T13:00:00Z"
       }
     ],
     "totalWallets": 10342,
     "lastUpdated": "2026-06-04T02:00:00Z"
   }
   ```

   **GET /api/smart-money/{walletAddress}**
   - Returns detailed info for single wallet
   - Response: SmartMoneyScore + trading history
   ```json
   {
     "address": "abc123...",
     "score": 92,
     "percentile": 98,
     "metrics": {...},
     "trades": [...],
     "recentActivity": {...},
     "currentHoldings": [...]
   }
   ```

   **GET /api/smart-money/history**
   - Returns historical leaderboard snapshots
   - Query: date, limit
   - Response: how wallets have moved in ranking

2. Rate limiting:
   - Public endpoints: 100 req/min per IP
   - Authenticated endpoints: 1000 req/min per API key
   - Leaderboard cache: 1 minute TTL

3. Error handling:
   - Invalid wallet address → 400 Bad Request
   - Wallet not ranked → 404 Not Found
   - Rate limited → 429 Too Many Requests

**Deliverable:** `app/api/smart-money/route.ts` with all endpoints

---

### Task 4: Historical Snapshots (6 hours)
**Store daily leaderboard snapshots for historical tracking**

1. What to snapshot:
   - Top 100 wallets on that date
   - Each wallet's rank, score, PnL
   - Timestamp and snapshot ID

2. Storage:
   - Daily snapshots: 365 per year
   - Keep: 1 year of history (minimum)
   - Query ability: filter by date range

3. Use cases:
   - "How has this wallet ranked over 30 days?"
   - "Which wallets entered/left top 100?"
   - "What's the rank velocity?"

4. Implementation:
   ```typescript
   interface LeaderboardSnapshot {
     snapshotDate: Date;
     wallets: Array<{
       rank: number;
       address: string;
       score: number;
       pnl: number;
     }>;
   }
   
   // Store daily snapshots
   async function storeSnapshot(snapshot: LeaderboardSnapshot) {
     await db.leaderboardHistory.insertOne(snapshot);
   }
   ```

**Deliverable:** `lib/snapshot-storage.ts` with historical tracking

---

### Task 5: Integration Tests (2 hours)
**Test ranker end-to-end**

1. Test scenarios:
   - Ranking algorithm produces consistent order
   - Deduplication prevents duplicate addresses
   - API endpoints return correct data
   - Historical tracking works across days
   - Performance: top 100 in <2 seconds

2. Test data:
   - Synthetic wallets with known scores
   - Real wallet data (Agent 3's validation set)

**Deliverable:** `app/api/__tests__/smart-money.test.ts` with integration tests

---

## DELIVERABLES BY FRIDAY 6PM ET

1. **lib/smart-money-ranker.ts** (ranking algorithm, deduplication)
2. **lib/leaderboard-pipeline.ts** (data pipeline, batch processing)
3. **app/api/smart-money/route.ts** (REST API endpoints)
4. **lib/snapshot-storage.ts** (historical tracking)
5. **app/api/__tests__/smart-money.test.ts** (integration tests)

---

## SUCCESS CRITERIA

✅ Top 100 wallets ranked consistently
✅ API returns results in <2 seconds
✅ No duplicate wallets in leaderboard
✅ Historical snapshots stored and queryable
✅ All integration tests passing

---

## DATA REQUIREMENTS

From previous agents:
- Agent 5: PnL calculations across tokens
- Agent 6: SmartMoneyScore per wallet
- Agent 7: Fast data access (<2s requirement)
- Agent 3: Validation on 40 wallets

---

## API USAGE PATTERN

```
User visits website
↓
GET /api/smart-money → Top 100 in <2s
↓
User clicks wallet #5
↓
GET /api/smart-money/{address} → Details in <1s
↓
User views "How this wallet ranked over time"
↓
GET /api/smart-money/history?address=xxx → Historical data
```

---

## NOTES

- Deduplication is critical (same wallet in multiple token holder lists)
- Ranking formula can be tweaked based on Agent 3's validation results
- Performance target: <2 seconds for top 100 (Agent 7 will optimize)
- Historical data is valuable for follow-up analysis
- API is the public interface—make it clean and fast

Build the live ranker. This is what users see.

**Go build the leaderboard.**
