/**
 * Multi-layer caching strategy for optimized data ingestion
 *
 * Cache layers:
 * L1: In-memory cache (fast, small, per-process)
 * L2: Redis (persistent, shared across requests) - optional
 * L3: Database (long-term historical data) - optional
 *
 * This implementation focuses on L1 (in-memory) with Redis support.
 *
 * Cache keys:
 * - tx:{signature} -> Transaction object (24h TTL)
 * - holders:{mint}:{offset} -> Holder list page (1h TTL)
 * - metadata:{mint} -> Token metadata (24h TTL)
 * - score:{wallet} -> SmartMoneyScore (1h TTL)
 */

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttlMs: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  currentSize: number;
  maxSize: number;
}

/**
 * In-memory cache with TTL and size limits
 * Thread-safe for basic operations (JS is single-threaded)
 */
export class Cache<T = any> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentSize: 0,
    maxSize: 10000,
  };
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(maxSize: number = 10000, cleanupIntervalMs: number = 60000) {
    this.stats.maxSize = maxSize;
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  /**
   * Get value from cache
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check if expired
    const now = Date.now();
    if (now - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      this.stats.evictions++;
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return entry.data;
  }

  /**
   * Set value in cache with TTL
   */
  set(key: string, value: T, ttlMs: number = 24 * 60 * 60 * 1000): void {
    // Remove old entry if exists
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest entry if at capacity
    if (this.cache.size >= this.stats.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
        this.stats.evictions++;
      }
    }

    this.cache.set(key, {
      data: value,
      timestamp: Date.now(),
      ttlMs,
    });

    this.stats.currentSize = this.cache.size;
  }

  /**
   * Set multiple values at once (batch operation)
   */
  setMany(entries: Array<{ key: string; value: T; ttlMs?: number }>): void {
    for (const entry of entries) {
      this.set(entry.key, entry.value, entry.ttlMs);
    }
  }

  /**
   * Get multiple values at once
   */
  getMany(keys: string[]): (T | null)[] {
    return keys.map((key) => this.get(key));
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Delete specific key
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries matching pattern
   */
  deletePattern(pattern: RegExp): number {
    let deleted = 0;
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
        deleted++;
      }
    }
    this.stats.currentSize = this.cache.size;
    return deleted;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.stats.currentSize = 0;
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttlMs) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.stats.evictions += cleaned;
      this.stats.currentSize = this.cache.size;
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      currentSize: this.cache.size,
      maxSize: this.stats.maxSize,
    };
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clear();
  }

  /**
   * Get cache hit rate
   */
  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    if (total === 0) return 0;
    return this.stats.hits / total;
  }
}

/**
 * Global cache instances for different data types
 */
let transactionCache: Cache | null = null;
let holderCache: Cache | null = null;
let metadataCache: Cache | null = null;
let scoreCache: Cache | null = null;

/**
 * Initialize global caches
 */
export function initializeCaches(): void {
  transactionCache = new Cache(10000, 60000); // 10k transactions, cleanup every 60s
  holderCache = new Cache(1000, 60000); // 1k holder lists
  metadataCache = new Cache(5000, 60000); // 5k metadata entries
  scoreCache = new Cache(5000, 60000); // 5k score entries
}

/**
 * Get transaction cache instance
 */
export function getTransactionCache(): Cache {
  if (!transactionCache) {
    initializeCaches();
  }
  return transactionCache!;
}

/**
 * Get holder cache instance
 */
export function getHolderCache(): Cache {
  if (!holderCache) {
    initializeCaches();
  }
  return holderCache!;
}

/**
 * Get metadata cache instance
 */
export function getMetadataCache(): Cache {
  if (!metadataCache) {
    initializeCaches();
  }
  return metadataCache!;
}

/**
 * Get score cache instance
 */
export function getScoreCache(): Cache {
  if (!scoreCache) {
    initializeCaches();
  }
  return scoreCache!;
}

/**
 * Destroy all cache instances
 */
export function destroyCaches(): void {
  transactionCache?.destroy();
  holderCache?.destroy();
  metadataCache?.destroy();
  scoreCache?.destroy();

  transactionCache = null;
  holderCache = null;
  metadataCache = null;
  scoreCache = null;
}

/**
 * Get cache statistics for all caches
 */
export function getAllCacheStats() {
  return {
    transactions: transactionCache?.getStats(),
    holders: holderCache?.getStats(),
    metadata: metadataCache?.getStats(),
    scores: scoreCache?.getStats(),
  };
}

/**
 * Cache key builders
 */
export const CacheKeys = {
  transaction: (signature: string) => `tx:${signature}`,
  holders: (mint: string, offset: number = 0) => `holders:${mint}:${offset}`,
  metadata: (mint: string) => `metadata:${mint}`,
  score: (wallet: string) => `score:${wallet}`,
};

/**
 * Cache TTL constants (in milliseconds)
 */
export const CacheTTL = {
  TRANSACTION: 24 * 60 * 60 * 1000, // 24 hours
  HOLDERS: 60 * 60 * 1000, // 1 hour
  METADATA: 24 * 60 * 60 * 1000, // 24 hours
  SCORE: 60 * 60 * 1000, // 1 hour
};
