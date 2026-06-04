# Agent 8: Implementation & Integration Guide

## Overview

This guide covers the implementation details and integration points for the Smart Money Ranker system built by Agent 8.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    LEADERBOARD SYSTEM                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────┐         ┌─────────────────┐
│   Agent 5   │         │    Agent 6      │
│   PnL       │         │ SmartMoneyScore │
│  Engine     │         │                 │
└──────┬──────┘         └────────┬────────┘
       │                          │
       └──────────┬───────────────┘
                  │
        ┌─────────▼──────────┐
        │ leaderboard-       │
        │ pipeline.ts        │
        │ (orchestration)    │
        └─────────┬──────────┘
                  │
        ┌─────────▼────────────────┐
        │ smart-money-ranker.ts    │
        │ (ranking algorithm)      │
        └─────────┬────────────────┘
                  │
        ┌─────────▼──────────────┐
        │ snapshot-storage.ts    │
        │ (historical tracking)  │
        └─────────┬──────────────┘
                  │
        ┌─────────▼──────────────┐
        │ Supabase / PostgreSQL  │
        │ (persistent storage)   │
        └───────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    REST API LAYER                            │
└─────────────────────────────────────────────────────────────┘

        ┌─────────▼──────────────┐
        │  app/api/smart-money   │
        │  route.ts (REST API)   │
        └─────────┬──────────────┘
                  │
        ┌─────────▼──────────────┐
        │  Caching Layer         │
        │  (1 min TTL)           │
        └─────────┬──────────────┘
                  │
        ┌─────────▼──────────────┐
        │  Rate Limiting         │
        │  100/min public        │
        │  1000/min authenticated│
        └─────────┬──────────────┘
                  │
        ┌─────────▼──────────────┐
        │  Agent 10 UI           │
        │  Leaderboard Display   │
        └───────────────────────┘
```

---

## File Structure

```
lib/
├── smart-money-ranker.ts
│   ├── WalletRankingMetrics (interface)
│   ├── RankedWallet (interface)
│   ├── calculateRankScore()
│   ├── rankWallets()
│   ├── deduplicateWallets()
│   ├── normalizePnL()
│   ├── filterByConfidence()
│   ├── calculatePercentile()
│   └── getRankingStatistics()
│
├── leaderboard-pipeline.ts
│   ├── PipelineConfig (interface)
│   ├── LeaderboardEntry (interface)
│   ├── LeaderboardSnapshot (interface)
│   ├── executeLeaderboardPipeline()
│   ├── fetchTopTokensByVolume()
│   ├── fetchTopHoldersForToken()
│   ├── analyzeWallet()
│   ├── storeLeaderboardSnapshot()
│   ├── getLatestLeaderboard()
│   ├── getLeaderboardHistory()
│   ├── getRankChanges()
│   └── getPipelineConfig()
│
└── snapshot-storage.ts
    ├── SnapshotEntry (interface)
    ├── LeaderboardSnapshot (interface)
    ├── RankChangeRecord (interface)
    ├── storeSnapshot()
    ├── getSnapshot()
    ├── getSnapshotRange()
    ├── calculateRankChange()
    ├── getWalletRankingHistory()
    ├── getNewEntriesOnDate()
    ├── getExitsOnDate()
    ├── getRankMoversOnDate()
    ├── getTopWalletsStatistics()
    ├── initializeSnapshotStorage()
    └── cleanupOldSnapshots()

app/api/
├── smart-money/
│   └── route.ts
│       ├── GET /api/smart-money
│       ├── GET /api/smart-money/{address}
│       └── GET /api/smart-money/history
│
└── __tests__/
    └── smart-money.test.ts
        ├── Ranking Algorithm tests (6)
        ├── PnL Normalization tests (4)
        ├── Deduplication tests (5)
        ├── Confidence Filtering tests (4)
        ├── Percentile tests (3)
        ├── Statistics tests (3)
        ├── Performance tests (3)
        ├── Edge Cases tests (4)
        └── Consistency tests (2)
```

---

## Step-by-Step Integration

### Step 1: Database Setup

Initialize the database schema:

```typescript
import { initializeSnapshotStorage } from '@/lib/snapshot-storage';

async function setupDatabase() {
  await initializeSnapshotStorage();
  console.log('Database ready');
}
```

This creates:
- `leaderboard_snapshots` table (stores daily rankings)
- `leaderboard_history` table (stores ranking changes)

### Step 2: Configure Environment

Add to `.env` or `.env.local`:

```env
# Solscan API for token/holder data
SOLSCAN_API_KEY=your_key_here

# Supabase for database
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here

# Pipeline scheduling
LEADERBOARD_UPDATE_HOUR=2  # 2 AM UTC
LEADERBOARD_UPDATE_MINUTE=0
```

### Step 3: Configure Pipeline

Create a pipeline configuration file:

```typescript
// lib/pipeline-config.ts
import { getPipelineConfig, PipelineEnvironment } from './leaderboard-pipeline';

const env = process.env.NODE_ENV as PipelineEnvironment;
export const pipelineConfig = getPipelineConfig(env);
```

### Step 4: Implement Integration Points

**Integrate with Agent 5 (PnL):**

```typescript
// In leaderboard-pipeline.ts analyzeWallet()
import { calculatePortfolioPnL } from '@/lib/pnl-engine';

export async function analyzeWallet(address: string): Promise<WalletRankingMetrics | null> {
  // Get PnL from Agent 5
  const pnl = await calculatePortfolioPnL(address);
  
  return {
    // ... other fields
    totalPnL: pnl.totalRealizedPnL,
    winRate: pnl.winRate,
    // ...
  };
}
```

**Integrate with Agent 6 (SmartMoneyScore):**

```typescript
// In leaderboard-pipeline.ts analyzeWallet()
import { analyzeWallet as analyzeSmartMoney } from '@/lib/wallet-analyzer';

export async function analyzeWallet(address: string): Promise<WalletRankingMetrics | null> {
  // Get SmartMoneyScore from Agent 6
  const analysis = await analyzeSmartMoney(address);
  
  return {
    smartMoneyScore: analysis.score,
    consistency: analysis.metrics.consistency,
    // ...
  };
}
```

**Integrate with Agent 7 (Fast Data):**

```typescript
// Use cached data from Agent 7
import { getTopHolders, getTokenMetadata } from '@/lib/helius-client';

export async function fetchTopHoldersForToken(mint: string): Promise<...> {
  // Agent 7 handles the fast caching
  return await getTopHolders(mint, 100);
}
```

### Step 5: Set Up Scheduled Pipeline

**Option A: Using Node Cron (Simple)**

```typescript
// lib/scheduler.ts
import cron from 'node-cron';
import { executeLeaderboardPipeline } from '@/lib/leaderboard-pipeline';
import { storeLeaderboardSnapshot } from '@/lib/snapshot-storage';

export function startPipelineScheduler() {
  // Run at 2:00 AM UTC every day
  cron.schedule('0 2 * * *', async () => {
    console.log('Starting daily leaderboard pipeline...');
    const snapshot = await executeLeaderboardPipeline();
    await storeLeaderboardSnapshot(snapshot);
    console.log('Pipeline complete');
  });
}
```

**Option B: Using Vercel Cron (Recommended for serverless)**

```typescript
// app/api/cron/leaderboard.ts
import { NextRequest, NextResponse } from 'next/server';
import { executeLeaderboardPipeline } from '@/lib/leaderboard-pipeline';
import { storeLeaderboardSnapshot } from '@/lib/snapshot-storage';

export async function GET(request: NextRequest) {
  // Verify this is from Vercel's cron
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const snapshot = await executeLeaderboardPipeline();
  await storeLeaderboardSnapshot(snapshot);

  return NextResponse.json({ success: true });
}

export const config = {
  runtime: 'nodejs',
};
```

Then configure in `vercel.json`:

```json
{
  "crons": [{
    "path": "/api/cron/leaderboard",
    "schedule": "0 2 * * *"
  }]
}
```

### Step 6: Test the Pipeline

```typescript
// scripts/test-pipeline.ts
import { executeLeaderboardPipeline } from '@/lib/leaderboard-pipeline';

async function testPipeline() {
  console.log('Starting test pipeline...');
  const snapshot = await executeLeaderboardPipeline();
  console.log(`Processed ${snapshot.wallets.length} wallets`);
  console.log(`Total analyzed: ${snapshot.totalWalletsAnalyzed}`);
  return snapshot;
}

testPipeline().catch(console.error);
```

Run:
```bash
npx tsx scripts/test-pipeline.ts
```

### Step 7: Test API Endpoints

```bash
# Get leaderboard
curl http://localhost:3000/api/smart-money

# Get wallet details
curl http://localhost:3000/api/smart-money/5Q544fRrra3E2z7LdueCjVSndJ

# Get history with authentication
curl -H "X-API-Key: sk_live_abc123" \
     http://localhost:3000/api/smart-money/history?days=30
```

### Step 8: Run Tests

```bash
# Run all tests
npm test

# Run only smart-money tests
npm test -- app/api/__tests__/smart-money.test.ts

# Run with verbose output
npm test -- app/api/__tests__/smart-money.test.ts --verbose

# Run in watch mode
npm test -- app/api/__tests__/smart-money.test.ts --watch
```

### Step 9: Monitor in Production

Set up monitoring for:

```typescript
// lib/monitoring.ts
export async function monitorLeaderboardPipeline() {
  const startTime = Date.now();
  
  try {
    const snapshot = await executeLeaderboardPipeline();
    const duration = Date.now() - startTime;
    
    // Send metrics
    await sendMetric('leaderboard.pipeline.duration', duration);
    await sendMetric('leaderboard.wallets.ranked', snapshot.wallets.length);
    
    if (duration > 120000) { // > 2 minutes
      await sendAlert('Pipeline took longer than expected: ' + duration + 'ms');
    }
  } catch (error) {
    await sendAlert('Pipeline failed: ' + error);
    throw error;
  }
}
```

---

## Configuration Reference

### Pipeline Config

```typescript
interface PipelineConfig {
  maxTokensToFetch: number;        // 20-200
  maxHoldersPerToken: number;      // 50-200
  maxRankedWallets: number;        // 100
  minConfidence: number;           // 0.0-1.0
  retryAttempts: number;           // 1-5
  retryDelayMs: number;            // 100-5000
}

// Presets
DEFAULT_CONFIG              // Production: 200 tokens, 3 retries
DEVELOPMENT_CONFIG          // Dev: 20 tokens, 1 retry
STAGING_CONFIG              // Staging: 100 tokens, 2 retries
```

### API Rate Limiting

```typescript
// Public (IP-based)
100 requests / minute

// Authenticated (API key)
1000 requests / minute

// Reset interval
60 seconds

// Header: Retry-After
Returns seconds to wait
```

### Caching

```typescript
// Leaderboard
Cache-Control: public, max-age=60  // 1 minute

// Wallet details
Cache-Control: public, max-age=300  // 5 minutes

// History
Cache-Control: public, max-age=3600  // 1 hour
```

---

## Troubleshooting

### Pipeline Times Out

**Problem:** `executeLeaderboardPipeline()` exceeds 2 minutes

**Solutions:**
1. Reduce `maxTokensToFetch` (use 100 instead of 200)
2. Reduce `maxHoldersPerToken` (use 50 instead of 100)
3. Increase batch size in pipeline (parallel processing)
4. Use Agent 7's cached data instead of fresh requests

```typescript
// Faster config
const fastConfig: PipelineConfig = {
  maxTokensToFetch: 100,
  maxHoldersPerToken: 50,
  maxRankedWallets: 100,
  retryAttempts: 1,
  retryDelayMs: 500,
};
```

### Database Slow Queries

**Problem:** Snapshot storage queries slow

**Solution:** Add indexes

```sql
-- Already created in initializeSnapshotStorage()
CREATE INDEX idx_snapshots_date ON leaderboard_snapshots(snapshot_date);
CREATE INDEX idx_history_wallet ON leaderboard_history(wallet_address);
CREATE INDEX idx_history_date ON leaderboard_history(snapshot_date);
```

### API Returns Cached Data Too Old

**Problem:** Leaderboard cache stale

**Solutions:**
1. Reduce TTL: `LEADERBOARD_CACHE_TTL = 30 * 1000` (30 seconds)
2. Bypass cache with header: `Cache-Control: no-cache`
3. Use authenticated endpoint for fresher data

### Tests Failing

**Problem:** Integration tests fail

**Solution:** Check dependencies:
```bash
# Verify all Agent 5/6 functions available
grep "export async function" lib/pnl-engine.ts
grep "export async function" lib/wallet-analyzer.ts

# Run in isolation
npm test -- app/api/__tests__/smart-money.test.ts --no-coverage
```

---

## Performance Optimization

### 1. Batch Processing

Current: Sequential wallet analysis
Better: Parallel batch processing

```typescript
// Process 10 wallets in parallel
const BATCH_SIZE = 10;
for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
  const batch = wallets.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map(analyzeWallet));
}
```

### 2. Caching

Current: In-memory caching
Better: Redis for distributed caching

```typescript
import redis from 'redis';
const client = redis.createClient();

export async function getLatestLeaderboard(): Promise<...> {
  const cached = await client.get('leaderboard:latest');
  if (cached) return JSON.parse(cached);
  
  const data = await fetchLeaderboard();
  await client.setEx('leaderboard:latest', 60, JSON.stringify(data));
  return data;
}
```

### 3. Incremental Updates

Current: Full ranking daily
Better: Incremental updates when data changes

```typescript
export async function updateChangedWallets() {
  // Only re-rank wallets that changed
  const changed = await getWalletsWithNewActivity();
  const metrics = await Promise.all(changed.map(analyzeWallet));
  const ranked = rankWallets(metrics);
  // Store only changed entries
}
```

### 4. Async Processing

Use message queue for long-running tasks:

```typescript
// queue.ts
import Bull from 'bull';

export const leaderboardQueue = new Bull('leaderboard', {
  redis: { host: process.env.REDIS_HOST },
});

leaderboardQueue.process(async (job) => {
  return await executeLeaderboardPipeline();
});

// Schedule
leaderboardQueue.add({}, { repeat: { cron: '0 2 * * *' } });
```

---

## Security Considerations

### 1. Input Validation

All endpoints validate:
- Wallet address format (44-88 chars)
- Query parameters (limit 1-100, offset ≥0)
- API key format

### 2. Rate Limiting

Prevent abuse:
- Per-IP limits (public)
- Per-key limits (authenticated)
- Exponential backoff on retry

### 3. Database Security

- Read-only queries for history
- Authenticated storage writes
- Supabase RLS policies

### 4. API Key Management

```typescript
// Never hardcode
const apiKey = process.env.API_KEY;

// Validate
if (!apiKey || !request.headers.get('x-api-key')?.startsWith('sk_')) {
  return error401();
}

// Hash for storage
const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
```

---

## Monitoring & Alerting

### Key Metrics

1. **Pipeline Success Rate**
   ```typescript
   await sendMetric('leaderboard.pipeline.success', 1);
   ```

2. **Pipeline Duration**
   ```typescript
   const duration = endTime - startTime;
   await sendMetric('leaderboard.pipeline.duration_ms', duration);
   ```

3. **API Response Time**
   ```typescript
   const responseTime = performance.now() - startTime;
   await sendMetric('api.response_time_ms', responseTime);
   ```

4. **Cache Hit Rate**
   ```typescript
   const hitRate = hits / (hits + misses) * 100;
   await sendMetric('cache.hit_rate_percent', hitRate);
   ```

### Alerts

Set up alerts for:
- Pipeline failure (trigger: error)
- Slow pipeline (trigger: duration > 120s)
- High error rate (trigger: errors > 10%)
- Cache exhaustion (trigger: memory > 90%)

---

## Next Steps

1. **Immediate:** Run tests, verify integration with Agent 5/6
2. **This Week:** Deploy to staging, test with real data
3. **Next Week:** Deploy to production, monitor metrics
4. **Ongoing:** Optimize based on performance data

---

## Contacts

For questions about:
- **Ranking Algorithm:** See smart-money-ranker.ts comments
- **Data Pipeline:** See leaderboard-pipeline.ts comments
- **API Endpoints:** See app/api/smart-money/route.ts comments
- **Tests:** Run `npm test -- app/api/__tests__/smart-money.test.ts`

All code is fully documented with JSDoc comments.
