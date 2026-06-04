# AGENT 7 BRIEF: Data Ingestion & Optimization

**Your Mission:** Get data fast. Analysis must run in <2 seconds.

**You have 40 hours over 1 week. Deliverable due Friday 6pm ET.**

---

## TASKS (Complete all 5)

### Task 1: Helius API Optimization (10 hours)
**Batch calls and implement smart caching**

1. Current bottleneck analysis:
   - N+1 RPC problem: getAddressTransactions calls getTransaction for each signature
   - Each wallet analysis makes 50-100 RPC calls
   - No caching between requests
   - Result: 30+ seconds per wallet

2. Optimization approach:
   - Batch Helius API calls (searchAssets, getAddressTransactions)
   - Implement request deduplication
   - Create a transaction cache (24h TTL)
   - Parallel requests instead of sequential

3. Implementation:
   ```typescript
   // Before: 100 sequential RPC calls → 30 seconds
   const txs = await getAddressTransactions(addr);
   for (const tx of txs) {
     const parsed = await getTransaction(tx.signature); // N+1 problem
   }
   
   // After: batch calls → 2 seconds
   const batch = txs.slice(0, 50).map(t => t.signature);
   const parsed = await batchGetTransactions(batch); // 1 call for 50
   ```

4. Caching strategy:
   - Redis or in-memory cache
   - Key: transaction signature
   - TTL: 24 hours
   - Size limit: 10k transactions

**Deliverable:** `lib/helius-optimized.ts` with batching & caching

---

### Task 2: Performance Benchmarking (8 hours)
**Measure and document performance improvements**

1. Benchmark setup:
   - Test wallets: 10 different address types
   - Metrics to measure:
     - Time to analyze 1 wallet
     - Time to analyze 100 holders
     - RPC calls per wallet
     - Cache hit rate

2. Run benchmarks:
   - Before optimization (baseline)
   - After each optimization
   - Final vs target

3. Expected results:
   ```
   Baseline: 30 seconds/wallet, 100 RPC calls
   After batching: 5 seconds/wallet, 20 RPC calls
   After caching: 2 seconds/wallet, 5 RPC calls (with cache hits)
   ```

4. Document:
   - Performance metrics
   - Bottleneck analysis
   - Optimization impact per technique
   - Cache effectiveness

**Deliverable:** `PERFORMANCE_BENCHMARK.md` with detailed metrics

---

### Task 3: Error Handling & Fallbacks (10 hours)
**Handle RPC failures gracefully**

1. Failure scenarios:
   - Helius API timeout
   - Rate limit hit
   - Partial data missing
   - Invalid wallet address
   - Network interruption

2. Fallback strategies:
   - Retry with exponential backoff
   - Use cached data if available
   - Partial results (if some RPC calls fail, return what we have)
   - Graceful degradation

3. Implementation:
   ```typescript
   // Retry logic with exponential backoff
   async function fetchWithRetry(fn, maxRetries = 3) {
     for (let i = 0; i < maxRetries; i++) {
       try {
         return await fn();
       } catch (err) {
         if (i === maxRetries - 1) throw err;
         await delay(Math.pow(2, i) * 1000); // 1s, 2s, 4s
       }
     }
   }
   
   // Graceful fallbacks
   const transactions = await fetchTransactions(addr)
     .catch(() => getCachedTransactions(addr) || []);
   ```

4. Test scenarios:
   - Timeout handling
   - Rate limit recovery
   - Partial failure recovery
   - Error messages to user

**Deliverable:** `lib/error-handler.ts` with retry logic and fallbacks

---

### Task 4: Caching Strategy (8 hours)
**Implement multi-layer caching**

1. Cache layers:
   - **L1:** In-memory cache (fast, small)
   - **L2:** Redis (persistent, shared across requests)
   - **L3:** Database (long-term historical data)

2. What to cache:
   - Transaction history (by signature)
   - Wallet holder lists (by token mint)
   - Token metadata (by mint address)
   - Calculated scores (by wallet address, 1h TTL)

3. Implementation:
   ```typescript
   // Cache keys
   tx:{signature} → Transaction object
   holders:{mint}:{offset} → Holder list page
   metadata:{mint} → Token metadata
   score:{wallet} → SmartMoneyScore (1h TTL)
   
   // Cache invalidation
   - Transactions: immutable, 24h TTL
   - Holders: update hourly
   - Scores: update when new tx detected
   ```

4. Monitoring:
   - Cache hit rate
   - Cache size
   - Eviction metrics
   - Performance impact

**Deliverable:** `lib/cache.ts` with multi-layer caching

---

### Task 5: Load Testing (4 hours)
**Test system under load**

1. Load test scenarios:
   - Concurrent wallet analyses: 10, 50, 100
   - Peak load: 100 requests/sec
   - Sustained load: 10 requests/sec for 60 seconds

2. Metrics to measure:
   - Response time distribution (p50, p95, p99)
   - Error rate under load
   - RPC rate limit behavior
   - Cache effectiveness

3. Tools:
   - k6 or Apache JMeter for load testing
   - Monitor RPC call counts
   - Track cache hit rates

4. Pass criteria:
   - p95 response time <3 seconds
   - Error rate <1%
   - No cascading failures

**Deliverable:** `LOAD_TEST_RESULTS.md` with metrics and recommendations

---

## DELIVERABLES BY FRIDAY 6PM ET

1. **lib/helius-optimized.ts** (batching, deduplication, smart requests)
2. **lib/cache.ts** (multi-layer caching strategy)
3. **lib/error-handler.ts** (retry logic, fallbacks, error handling)
4. **PERFORMANCE_BENCHMARK.md** (before/after metrics, bottleneck analysis)
5. **LOAD_TEST_RESULTS.md** (concurrent load testing, p95 latency)

---

## SUCCESS CRITERIA

✅ Top 100 holders: <2 seconds (Agent 8's requirement)
✅ Single wallet: <500ms (Agent 6's requirement)
✅ RPC calls reduced 90%+
✅ Error handling covers all failure scenarios
✅ Load test shows p95 <3 seconds

---

## PERFORMANCE TARGETS

```
Current:          Target:
Wallet: 30s       Wallet: 500ms
100 holders: 5m   100 holders: 2s
RPC calls: 100    RPC calls: 5
```

---

## INTEGRATION POINTS

- Uses: Agent 5 (PnL engine), Agent 6 (wallet analyzer)
- Feeds to: Agent 8 (leaderboard needs <2s per wallet)
- Feeds to: Agent 10 (UI needs fast loads)

---

## NOTES

- Helius API is the bottleneck—focus there first
- Cache invalidation is hard—document your strategy
- Test with real wallet data (not synthetic)
- Monitor RPC rate limits (Helius has quotas)
- Performance is critical for user experience

Speed is a feature. Make this fast.

**Go make this <2 seconds.**
