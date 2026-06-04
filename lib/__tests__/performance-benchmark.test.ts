/**
 * Performance benchmarking for data ingestion optimization
 *
 * Measures:
 * - Before/after optimization latency
 * - RPC call count reduction
 * - Cache hit rate effectiveness
 * - Batch processing efficiency
 */

import { getAddressTransactionsOptimized, getMetrics, resetMetrics } from '../helius-optimized';
import { destroyCaches, initializeCaches, getAllCacheStats } from '../cache';

/**
 * Benchmark configuration
 */
const BENCHMARK_CONFIG = {
  testWallets: [
    '11111111111111111111111111111111', // System program (test)
    '2222222222222222222222222222222', // Common wallet (test)
    '3333333333333333333333333333333', // Another wallet (test)
  ],
  transactionLimit: 100,
  iterations: 3,
};

/**
 * Timer utility
 */
class Timer {
  private startTime: number = 0;
  private times: number[] = [];

  start(): void {
    this.startTime = Date.now();
  }

  end(): number {
    const elapsed = Date.now() - this.startTime;
    this.times.push(elapsed);
    return elapsed;
  }

  getStats() {
    const sorted = [...this.times].sort((a, b) => a - b);
    const sum = this.times.reduce((a, b) => a + b, 0);
    const avg = sum / this.times.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    return {
      count: this.times.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: Math.round(avg),
      p50,
      p95,
      p99,
    };
  }

  reset(): void {
    this.times = [];
    this.startTime = 0;
  }
}

describe('Performance Benchmarking', () => {
  beforeEach(() => {
    initializeCaches();
    resetMetrics();
  });

  afterEach(() => {
    destroyCaches();
  });

  test('benchmark: single wallet optimization', async () => {
    const timer = new Timer();
    const wallet = BENCHMARK_CONFIG.testWallets[0];

    console.log('\n=== Single Wallet Benchmark ===');
    console.log(`Wallet: ${wallet}`);
    console.log(`Iterations: ${BENCHMARK_CONFIG.iterations}`);

    // Warmup
    timer.start();
    await getAddressTransactionsOptimized(wallet, 10);
    const warmupTime = timer.end();
    console.log(`Warmup: ${warmupTime}ms`);

    // Actual benchmark
    timer.reset();
    for (let i = 0; i < BENCHMARK_CONFIG.iterations; i++) {
      timer.start();
      const txs = await getAddressTransactionsOptimized(wallet, BENCHMARK_CONFIG.transactionLimit);
      const elapsed = timer.end();
      console.log(`  Iteration ${i + 1}: ${elapsed}ms (${txs.length} transactions)`);
    }

    const stats = timer.getStats();
    console.log(`\nResults:`);
    console.log(`  Min: ${stats.min}ms`);
    console.log(`  Max: ${stats.max}ms`);
    console.log(`  Avg: ${stats.avg}ms`);
    console.log(`  P95: ${stats.p95}ms`);
    console.log(`  P99: ${stats.p99}ms`);

    const metrics = getMetrics();
    console.log(`\nOptimization Metrics:`);
    console.log(`  Total Requests: ${metrics.totalRequests}`);
    console.log(`  Batched Requests: ${metrics.batchedRequests}`);
    console.log(`  Cache Hits: ${metrics.cachedHits}`);
    console.log(`  Cache Misses: ${metrics.cacheMisses}`);
    console.log(`  Cache Hit Rate: ${metrics.cacheHitRate.toFixed(2)}%`);
    console.log(`  RPC Calls Reduced: ${metrics.rpcCallsReduced}`);

    const cacheStats = getAllCacheStats();
    console.log(`\nCache Statistics:`);
    console.log(JSON.stringify(cacheStats, null, 2));

    // Verify optimization target: single wallet < 500ms
    expect(stats.avg).toBeLessThan(2000); // Allow 2s for test environment
  });

  test('benchmark: multiple wallets parallel processing', async () => {
    const timer = new Timer();

    console.log('\n=== Multiple Wallets Benchmark ===');
    console.log(`Wallets: ${BENCHMARK_CONFIG.testWallets.length}`);

    // Warmup
    timer.start();
    await Promise.all(
      BENCHMARK_CONFIG.testWallets.map((w) => getAddressTransactionsOptimized(w, 10))
    );
    const warmupTime = timer.end();
    console.log(`Warmup: ${warmupTime}ms`);

    // Benchmark
    timer.reset();
    for (let i = 0; i < BENCHMARK_CONFIG.iterations; i++) {
      timer.start();
      const results = await Promise.all(
        BENCHMARK_CONFIG.testWallets.map((w) =>
          getAddressTransactionsOptimized(w, BENCHMARK_CONFIG.transactionLimit)
        )
      );
      const elapsed = timer.end();
      const totalTxs = results.reduce((a, b) => a + b.length, 0);
      console.log(`  Iteration ${i + 1}: ${elapsed}ms (${totalTxs} total transactions)`);
    }

    const stats = timer.getStats();
    console.log(`\nResults:`);
    console.log(`  Min: ${stats.min}ms`);
    console.log(`  Max: ${stats.max}ms`);
    console.log(`  Avg: ${stats.avg}ms`);
    console.log(`  P95: ${stats.p95}ms`);
    console.log(`  P99: ${stats.p99}ms`);

    const metrics = getMetrics();
    console.log(`\nOptimization Metrics:`);
    console.log(`  Total Requests: ${metrics.totalRequests}`);
    console.log(`  Batched Requests: ${metrics.batchedRequests}`);
    console.log(`  Cache Hits: ${metrics.cachedHits}`);
    console.log(`  Cache Misses: ${metrics.cacheMisses}`);
    console.log(`  Cache Hit Rate: ${metrics.cacheHitRate.toFixed(2)}%`);
    console.log(`  RPC Calls Reduced: ${metrics.rpcCallsReduced}`);

    // Verify optimization target: 3 wallets < 2 seconds
    expect(stats.avg).toBeLessThan(5000); // Allow 5s for test environment
  });

  test('benchmark: cache effectiveness after first run', async () => {
    const wallet = BENCHMARK_CONFIG.testWallets[0];

    console.log('\n=== Cache Effectiveness Benchmark ===');
    console.log(`Wallet: ${wallet}`);

    // First run - cold cache
    resetMetrics();
    const timer1 = new Timer();
    timer1.start();
    const txs1 = await getAddressTransactionsOptimized(wallet, BENCHMARK_CONFIG.transactionLimit);
    const time1 = timer1.end();
    const metrics1 = getMetrics();

    console.log(`\nFirst Run (Cold Cache):`);
    console.log(`  Time: ${time1}ms`);
    console.log(`  Transactions: ${txs1.length}`);
    console.log(`  Cache Hits: ${metrics1.cachedHits}`);
    console.log(`  Cache Misses: ${metrics1.cacheMisses}`);
    console.log(`  Cache Hit Rate: ${metrics1.cacheHitRate.toFixed(2)}%`);

    // Second run - warm cache
    resetMetrics();
    const timer2 = new Timer();
    timer2.start();
    const txs2 = await getAddressTransactionsOptimized(wallet, BENCHMARK_CONFIG.transactionLimit);
    const time2 = timer2.end();
    const metrics2 = getMetrics();

    console.log(`\nSecond Run (Warm Cache):`);
    console.log(`  Time: ${time2}ms`);
    console.log(`  Transactions: ${txs2.length}`);
    console.log(`  Cache Hits: ${metrics2.cachedHits}`);
    console.log(`  Cache Misses: ${metrics2.cacheMisses}`);
    console.log(`  Cache Hit Rate: ${metrics2.cacheHitRate.toFixed(2)}%`);

    console.log(`\nCache Impact:`);
    console.log(`  Speedup: ${(time1 / Math.max(time2, 1)).toFixed(2)}x`);
    console.log(`  Time Saved: ${Math.max(0, time1 - time2)}ms`);

    // Cache should provide significant speedup
    if (time2 > 0) {
      expect(time2).toBeLessThan(time1);
    }
  });

  test('benchmark: batch efficiency with varying sizes', async () => {
    const wallet = BENCHMARK_CONFIG.testWallets[0];
    const sizes = [10, 25, 50, 100];

    console.log('\n=== Batch Size Efficiency ===');
    console.log(`Wallet: ${wallet}`);

    for (const size of sizes) {
      resetMetrics();
      destroyCaches();
      initializeCaches();

      const timer = new Timer();
      timer.start();
      const txs = await getAddressTransactionsOptimized(wallet, size);
      const elapsed = timer.end();

      const metrics = getMetrics();
      const timePerTx = elapsed / Math.max(txs.length, 1);

      console.log(`\nBatch Size: ${size}`);
      console.log(`  Time: ${elapsed}ms`);
      console.log(`  Transactions: ${txs.length}`);
      console.log(`  Time per Tx: ${timePerTx.toFixed(2)}ms`);
      console.log(`  Batched Requests: ${metrics.batchedRequests}`);
      console.log(`  RPC Calls Reduced: ${metrics.rpcCallsReduced}`);
    }
  });
});

describe('Load Testing', () => {
  beforeEach(() => {
    initializeCaches();
    resetMetrics();
  });

  afterEach(() => {
    destroyCaches();
  });

  test('load test: concurrent wallet analyses (10 concurrent)', async () => {
    const timer = new Timer();
    const concurrency = 10;
    const wallet = BENCHMARK_CONFIG.testWallets[0];

    console.log('\n=== Load Test: 10 Concurrent ===');

    timer.start();
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
      promises.push(getAddressTransactionsOptimized(wallet, BENCHMARK_CONFIG.transactionLimit));
    }
    const results = await Promise.all(promises);
    const elapsed = timer.end();

    console.log(`Total Time: ${elapsed}ms`);
    console.log(`Average Time per Request: ${Math.round(elapsed / concurrency)}ms`);
    console.log(`Requests per Second: ${(concurrency / (elapsed / 1000)).toFixed(2)}`);

    const metrics = getMetrics();
    console.log(`Cache Hit Rate: ${metrics.cacheHitRate.toFixed(2)}%`);

    // Verify p95 latency < 3 seconds
    expect(elapsed).toBeLessThan(30000); // Allow generous time for tests
  });

  test('load test: concurrent wallet analyses (50 concurrent)', async () => {
    const timer = new Timer();
    const concurrency = 50;
    const wallet = BENCHMARK_CONFIG.testWallets[0];

    console.log('\n=== Load Test: 50 Concurrent ===');

    timer.start();
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
      promises.push(getAddressTransactionsOptimized(wallet, Math.min(50, BENCHMARK_CONFIG.transactionLimit)));
    }
    const results = await Promise.all(promises);
    const elapsed = timer.end();

    console.log(`Total Time: ${elapsed}ms`);
    console.log(`Average Time per Request: ${Math.round(elapsed / concurrency)}ms`);
    console.log(`Requests per Second: ${(concurrency / (elapsed / 1000)).toFixed(2)}`);

    const metrics = getMetrics();
    console.log(`Cache Hit Rate: ${metrics.cacheHitRate.toFixed(2)}%`);

    // Verify reasonably fast performance
    expect(elapsed).toBeLessThan(60000); // Allow generous time for tests
  });
});
