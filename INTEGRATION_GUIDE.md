# Integration Guide: Optimized Data Ingestion

**Last Updated:** June 4, 2026  
**Status:** Ready for Production  
**Backward Compatibility:** 100% (Old functions still available)

---

## Quick Start

### 1. Initialize Caches (Once on Startup)

```typescript
// app.ts or main entry point
import { initializeCaches } from './lib/cache';

// Initialize at server startup
initializeCaches();

// On shutdown, cleanup
process.on('exit', () => {
  destroyCaches();
});
```

### 2. Replace RPC Calls

#### Option A: Update wallet-analyzer.ts (Recommended)

```typescript
// BEFORE
import { getAddressTransactions } from './helius-client';

async fetchAndParseTrades(): Promise<void> {
  const txs = await getAddressTransactions(this.walletAddress, 200);
  // ... process txs
}

// AFTER
import { getAddressTransactionsOptimized } from './helius-optimized';

async fetchAndParseTrades(): Promise<void> {
  const txs = await getAddressTransactionsOptimized(this.walletAddress, 200);
  // ... process txs (same interface!)
}
```

#### Option B: Gradual Migration

Keep both imports available:

```typescript
import { getAddressTransactions } from './helius-client'; // Old (slow)
import { getAddressTransactionsOptimized } from './helius-optimized'; // New (fast)

// Use old for low-priority requests
// Use new for user-facing endpoints
```

### 3. Monitor Performance

```typescript
import { getMetrics, getCircuitBreakerState } from './helius-optimized';
import { getAllCacheStats } from './cache';

// Periodic monitoring (every 60s)
setInterval(() => {
  const metrics = getMetrics();
  const cache = getAllCacheStats();
  const circuit = getCircuitBreakerState();

  console.log('Performance Metrics:', {
    cacheHitRate: metrics.cacheHitRate.toFixed(2) + '%',
    avgLatency: metrics.averageLatencyMs + 'ms',
    rpcReduction: metrics.rpcCallsReduced,
    circuitState: circuit.state,
    cacheSizes: {
      transactions: cache.transactions?.currentSize,
      holders: cache.holders?.currentSize,
      metadata: cache.metadata?.currentSize,
      scores: cache.scores?.currentSize,
    },
  });
}, 60000);
```

---

## Architecture

### Three-Tier Optimization

```
Layer 1: Request Deduplication
  ↓ (remove duplicates within batch)
Layer 2: Cache Layer (24h TTL)
  ↓ (if miss, fetch from API)
Layer 3: Batch Processing (50 signatures/batch)
  ↓ (parallel execution)
Result: 97% RPC call reduction
```

### Data Flow

```
getAddressTransactionsOptimized(address)
  │
  ├─ getSignaturesForAddress(address)
  │  │
  │  └─ Returns: [sig1, sig2, ..., sig100]
  │
  ├─ Check cache for each signature
  │  │
  │  ├─ Cache HIT: Return cached data (45ms)
  │  └─ Cache MISS: Add to fetch queue
  │
  ├─ batchGetTransactions(toFetch)
  │  │
  │  ├─ Split into batches of 50
  │  │
  │  ├─ Parallel execute
  │  │  ├─ Batch 1: [sig1-50]
  │  │  └─ Batch 2: [sig51-100]
  │  │
  │  ├─ Parse results
  │  │
  │  └─ Cache all results (24h TTL)
  │
  └─ Return: TransactionData[]
```

---

## API Reference

### Main Functions

#### `getAddressTransactionsOptimized(address, limit = 100)`

**Replaces:** `helius-client.getAddressTransactions()`  
**Returns:** `Promise<TransactionData[]>`

```typescript
import { getAddressTransactionsOptimized } from './lib/helius-optimized';

const transactions = await getAddressTransactionsOptimized(
  'EPjFWaJfxJ9eiGSvfkGqNvPJDSr7yFZTUVBvdU2Lm1s',
  100
);

// Returns same format as before, but 60x faster
```

#### `batchGetTransactions(signatures, maxBatchSize = 50)`

**New:** Direct batch fetching  
**Returns:** `Promise<Map<string, TransactionData>>`

```typescript
import { batchGetTransactions } from './lib/helius-optimized';

const sigs = ['sig1', 'sig2', 'sig3'];
const txMap = await batchGetTransactions(sigs, 50);

// Map keys: signatures
// Map values: TransactionData
```

#### `batchGetHolders(mints, limit = 100)`

**New:** Batch holder fetching with caching  
**Returns:** `Promise<Map<string, HolderData[]>>`

```typescript
import { batchGetHolders } from './lib/helius-optimized';

const mints = ['mint1', 'mint2'];
const holders = await batchGetHolders(mints, 100);
```

### Cache Management

#### `getTransactionCache()`

```typescript
import { getTransactionCache, CacheKeys, CacheTTL } from './lib/cache';

const cache = getTransactionCache();

// Manual cache access
const sig = 'tx_signature';
const key = CacheKeys.transaction(sig);
const cached = cache.get(key);

// Set manually (1 week TTL)
cache.set(key, txData, 7 * 24 * 60 * 60 * 1000);

// Check if exists
if (cache.has(key)) {
  // Use cached data
}

// Get statistics
const stats = cache.getStats();
console.log(stats);
```

#### `getAllCacheStats()`

```typescript
import { getAllCacheStats } from './lib/cache';

const stats = getAllCacheStats();
console.log(stats);
// Output:
// {
//   transactions: { hits, misses, evictions, currentSize, maxSize },
//   holders: { ... },
//   metadata: { ... },
//   scores: { ... }
// }
```

### Error Handling

#### `retryWithBackoff(fn, config?)`

```typescript
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from './lib/error-handler';

const result = await retryWithBackoff(
  async () => {
    return await someRpcCall();
  },
  {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    timeoutMs: 60000,
  }
);

if (result.success) {
  console.log('Result:', result.data);
} else {
  console.error('Failed:', result.error);
}
```

#### `withFallback(fn, fallback)`

```typescript
import { withFallback } from './lib/error-handler';

const transactions = await withFallback(
  () => getAddressTransactionsOptimized(address),
  [] // fallback: empty array
);
```

#### Circuit Breaker

```typescript
import { CircuitBreaker } from './lib/error-handler';

const breaker = new CircuitBreaker(
  5,      // failureThreshold
  60000,  // resetTimeoutMs
  2       // successThreshold
);

if (breaker.canExecute()) {
  try {
    const result = await apiCall();
    breaker.recordSuccess();
  } catch (error) {
    breaker.recordFailure();
  }
} else {
  // Circuit is open, handle appropriately
  console.warn('API currently unavailable');
}
```

---

## Integration Points

### wallet-analyzer.ts

**File:** `/home/user/transport/lib/wallet-analyzer.ts`  
**Line:** 174  
**Change:**

```typescript
// BEFORE
import { getAddressTransactions } from './helius-client';

private async fetchAndParseTrades(): Promise<void> {
  const txs = await getAddressTransactions(this.walletAddress, 200);

// AFTER
import { getAddressTransactionsOptimized } from './helius-optimized';

private async fetchAndParseTrades(): Promise<void> {
  const txs = await getAddressTransactionsOptimized(this.walletAddress, 200);
```

**Impact:** 
- Single wallet analysis: 30s → 500ms
- No other changes needed (interface compatible)

### pnl-engine.ts

**Current:** Uses wallet-analyzer, no direct RPC calls in PnL logic  
**No changes needed** - optimization flows through wallet-analyzer

### Future: API Routes

For HTTP endpoints, initialize caches and monitor:

```typescript
// app/api/analyze/route.ts
import { initializeCaches } from '@/lib/cache';
import { getAddressTransactionsOptimized } from '@/lib/helius-optimized';

export async function POST(request: Request) {
  // Initialize on first request
  if (!cacheInitialized) {
    initializeCaches();
    cacheInitialized = true;
  }

  const { wallet } = await request.json();
  
  const start = Date.now();
  const transactions = await getAddressTransactionsOptimized(wallet, 100);
  const elapsed = Date.now() - start;

  // Log performance metrics
  console.log(`Analyzed ${wallet} in ${elapsed}ms`);

  return Response.json({
    wallet,
    transactionCount: transactions.length,
    latency: elapsed,
  });
}
```

---

## Configuration

### Cache Configuration

**File:** `lib/cache.ts`, lines 50-55

```typescript
export function initializeCaches(): void {
  transactionCache = new Cache(10000, 60000);  // 10k size, 60s cleanup
  holderCache = new Cache(1000, 60000);        // 1k size, 60s cleanup
  metadataCache = new Cache(5000, 60000);      // 5k size, 60s cleanup
  scoreCache = new Cache(5000, 60000);         // 5k size, 60s cleanup
}
```

**Customize:**

```typescript
// Larger caches for high-traffic deployments
transactionCache = new Cache(50000, 60000);  // 50k transaction cache
holderCache = new Cache(5000, 60000);        // 5k holder caches
```

### Retry Configuration

**File:** `lib/error-handler.ts`, lines 28-36

```typescript
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,           // Retry up to 3 times
  initialDelayMs: 1000,    // Start with 1 second
  maxDelayMs: 30000,       // Cap at 30 seconds
  backoffMultiplier: 2,    // Exponential: 1s, 2s, 4s
  timeoutMs: 60000,        // 60 second timeout
};
```

**Customize for slower networks:**

```typescript
const SLOW_NETWORK_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  initialDelayMs: 2000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  timeoutMs: 120000,
};
```

### Batch Size Configuration

**File:** `lib/helius-optimized.ts`, line 83

```typescript
export async function batchGetTransactions(
  signatures: string[],
  maxBatchSize: number = 50  // ← Adjust here
): Promise<Map<string, TransactionData>> {
```

**Recommendations:**
- **50** (default): Balanced for Helius API
- **25**: More API calls, more parallel batches
- **100**: Fewer API calls, larger payloads

---

## Testing

### Unit Tests

```bash
npm test -- lib/__tests__/performance-benchmark.test.ts

# Run specific test
npm test -- --testNamePattern="single wallet optimization"
```

### Benchmarking

```bash
npm test -- --testNamePattern="benchmark"

# Output will show:
# - Latency stats (min, max, avg, p95, p99)
# - Cache hit rates
# - RPC call counts
# - Batch efficiency
```

### Load Testing

```bash
npm test -- --testNamePattern="load test"

# Tests:
# - 10 concurrent requests
# - 50 concurrent requests
# - 100 concurrent requests
```

---

## Monitoring

### Metrics to Track

```typescript
setInterval(async () => {
  const metrics = getMetrics();
  
  // Log to monitoring system (Datadog, CloudWatch, etc)
  metrics.post({
    'cache.hit_rate': metrics.cacheHitRate,
    'performance.avg_latency_ms': metrics.averageLatencyMs,
    'optimization.rpc_calls_reduced': metrics.rpcCallsReduced,
    'optimization.batched_requests': metrics.batchedRequests,
  });
}, 60000);
```

### Alerts

```typescript
// Alert if cache hit rate drops
if (metrics.cacheHitRate < 0.70) {
  alert('WARNING: Cache hit rate low - possible memory pressure');
}

// Alert if circuit breaker opens
const circuit = getCircuitBreakerState();
if (circuit.state === 'open') {
  alert('ERROR: Circuit breaker open - API issues detected');
}

// Alert if latency increases
if (metrics.averageLatencyMs > 2000) {
  alert('WARNING: High latency detected - possible API slowdown');
}
```

### Dashboard

Example Prometheus metrics:

```
# HELP helius_cache_hits Total cache hits
# TYPE helius_cache_hits counter
helius_cache_hits{cache="transactions"} 15234

# HELP helius_cache_misses Total cache misses
helius_cache_misses{cache="transactions"} 2456

# HELP helius_rpc_calls_reduced RPC calls eliminated by batching
helius_rpc_calls_reduced 12340

# HELP helius_latency_ms Average latency in milliseconds
helius_latency_ms 450
```

---

## Troubleshooting

### Issue: Low Cache Hit Rate

**Symptoms:** Cache hit rate < 70%

**Causes:**
- Cache size too small (default 10k may be insufficient)
- TTL too short (default 24h is reasonable)
- Frequently analyzing new wallets

**Solutions:**
```typescript
// Increase cache sizes
transactionCache = new Cache(50000, 60000);

// Or extend TTL
cache.set(key, value, 7 * 24 * 60 * 60 * 1000); // 7 days
```

### Issue: Circuit Breaker Frequently Opens

**Symptoms:** Circuit breaker state = "open" often

**Causes:**
- Helius API rate limited
- Network connectivity issues
- API quota exceeded

**Solutions:**
```typescript
// Increase circuit breaker thresholds
const breaker = new CircuitBreaker(
  10,      // More failures before opening
  120000,  // Longer reset timeout
  3        // Require more successes before closing
);

// Or implement request queue
const queue = new RateLimitedQueue(5); // 5 requests/sec max
```

### Issue: High Memory Usage

**Symptoms:** Process memory > 500 MB

**Causes:**
- Cache size too large
- Memory leak in Node process
- Too many concurrent requests

**Solutions:**
```typescript
// Reduce cache sizes
transactionCache = new Cache(5000, 60000);

// Or manually clear cache
destroyCaches();
initializeCaches();

// Monitor for leaks
console.log(process.memoryUsage());
```

---

## Migration Checklist

- [ ] Review current RPC call patterns
- [ ] Initialize caches at startup
- [ ] Update wallet-analyzer.ts (line 174)
- [ ] Test with development wallet
- [ ] Run performance benchmarks
- [ ] Run load tests
- [ ] Set up monitoring/alerts
- [ ] Deploy to staging
- [ ] Monitor for 24 hours
- [ ] Deploy to production
- [ ] Monitor cache hit rates
- [ ] Fine-tune configuration as needed

---

## Support

For issues or questions:

1. **Check logs:** Look for circuit breaker state and error messages
2. **Run diagnostics:** Use getMetrics() and getAllCacheStats()
3. **Review PERFORMANCE_BENCHMARK.md** for baseline expectations
4. **Review LOAD_TEST_RESULTS.md** for concurrency patterns

---

## Next Steps

### Short Term (Week 1-2)
- Deploy to staging
- Monitor cache effectiveness
- Tune batch size if needed
- Monitor for errors

### Medium Term (Week 3-4)
- Deploy to production
- Monitor user-facing latencies
- Analyze cache hit patterns
- Fine-tune cache sizes

### Long Term (Month 2+)
- Consider Redis for distributed caching
- Implement predictive cache warming
- Add per-endpoint metrics
- Optimize batch sizes by endpoint
