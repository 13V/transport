/**
 * Error handling and retry logic for RPC operations
 *
 * Implements:
 * - Exponential backoff retry logic
 * - Rate limit detection and handling
 * - Graceful degradation on failures
 * - Partial result recovery
 * - Error classification and logging
 */

export type ErrorSeverity = 'transient' | 'rate_limit' | 'permanent' | 'unknown';

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  timeoutMs: number;
}

export interface ErrorContext {
  attempt: number;
  totalAttempts: number;
  lastError?: Error;
  elapsed: number;
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  elapsed: number;
}

/**
 * Default retry configuration for Helius API
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000, // 1 second
  maxDelayMs: 30000, // 30 seconds
  backoffMultiplier: 2, // exponential backoff: 1s, 2s, 4s
  timeoutMs: 60000, // 60 second timeout
};

/**
 * Classify error type for retry decisions
 */
export function classifyError(error: any): ErrorSeverity {
  if (!error) return 'unknown';

  const message = error.message?.toLowerCase() || '';
  const status = error.status || error.response?.status;

  // Rate limit errors
  if (status === 429 || message.includes('rate limit') || message.includes('too many requests')) {
    return 'rate_limit';
  }

  // Transient errors (worth retrying)
  if (
    status === 408 || // request timeout
    status === 429 || // too many requests
    status === 500 || // internal server error
    status === 502 || // bad gateway
    status === 503 || // service unavailable
    status === 504 || // gateway timeout
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('eagain')
  ) {
    return 'transient';
  }

  // Permanent errors (don't retry)
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return 'permanent';
  }

  return 'unknown';
}

/**
 * Calculate delay for retry with exponential backoff
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig
): number {
  const exponentialDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const capped = Math.min(exponentialDelay, config.maxDelayMs);
  // Add jitter (±20%) to prevent thundering herd
  const jitter = capped * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

/**
 * Delay execution
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 * Returns first successful result or throws last error
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (context: ErrorContext) => void
): Promise<RetryResult<T>> {
  const startTime = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise<T>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Operation timeout after ${config.timeoutMs}ms`)),
            config.timeoutMs
          )
        ),
      ]);

      return {
        success: true,
        data: result,
        attempts: attempt + 1,
        elapsed: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const severity = classifyError(error);

      // Don't retry permanent errors
      if (severity === 'permanent') {
        return {
          success: false,
          error: lastError,
          attempts: attempt + 1,
          elapsed: Date.now() - startTime,
        };
      }

      // If this is the last attempt, give up
      if (attempt === config.maxRetries - 1) {
        return {
          success: false,
          error: lastError,
          attempts: attempt + 1,
          elapsed: Date.now() - startTime,
        };
      }

      // Wait before retrying
      const waitTime = calculateBackoffDelay(attempt, config);

      if (onRetry) {
        onRetry({
          attempt: attempt + 1,
          totalAttempts: config.maxRetries,
          lastError,
          elapsed: Date.now() - startTime,
        });
      }

      await delay(waitTime);
    }
  }

  // This shouldn't be reached due to the return in the loop
  return {
    success: false,
    error: lastError || new Error('Unknown error'),
    attempts: config.maxRetries,
    elapsed: Date.now() - startTime,
  };
}

/**
 * Batch operation with partial failure tolerance
 * Returns successful results and tracks failures
 */
export async function batchWithFallback<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<{
  results: R[];
  failures: Array<{ item: T; error: Error }>;
  successCount: number;
  failureCount: number;
}> {
  const results: R[] = [];
  const failures: Array<{ item: T; error: Error }> = [];

  // Process in parallel with retry for each
  const promises = items.map(async (item) => {
    const result = await retryWithBackoff(() => fn(item), config);

    if (result.success && result.data) {
      results.push(result.data);
    } else {
      failures.push({
        item,
        error: result.error || new Error('Unknown error'),
      });
    }
  });

  await Promise.all(promises);

  return {
    results,
    failures,
    successCount: results.length,
    failureCount: failures.length,
  };
}

/**
 * Wrapper for graceful error handling with fallback
 * Returns either successful result or fallback value
 */
export async function withFallback<T>(
  fn: () => Promise<T>,
  fallback: T,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  const result = await retryWithBackoff(fn, config);
  return result.success && result.data ? result.data : fallback;
}

/**
 * Create a rate-limited queue for API calls
 * Prevents overwhelming the API and hitting rate limits
 */
export class RateLimitedQueue {
  private queue: Array<() => Promise<any>> = [];
  private processing = false;
  private lastCallTime = 0;
  private minIntervalMs: number;

  constructor(callsPerSecond: number = 10) {
    // If 10 calls per second, minimum 100ms between calls
    this.minIntervalMs = 1000 / callsPerSecond;
  }

  /**
   * Add a function to the queue
   */
  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  /**
   * Process queue with rate limiting
   */
  private async processQueue(): Promise<void> {
    this.processing = true;

    while (this.queue.length > 0) {
      const fn = this.queue.shift();
      if (fn) {
        // Wait until minimum interval has passed
        const now = Date.now();
        const timeSinceLastCall = now - this.lastCallTime;
        if (timeSinceLastCall < this.minIntervalMs) {
          await delay(this.minIntervalMs - timeSinceLastCall);
        }

        this.lastCallTime = Date.now();
        await fn();
      }
    }

    this.processing = false;
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }
}

/**
 * Circuit breaker for preventing cascading failures
 * Opens circuit after threshold failures, preventing further attempts
 */
export class CircuitBreaker {
  private failureCount = 0;
  private successCount = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;

  constructor(
    failureThreshold: number = 5,
    resetTimeoutMs: number = 60000,
    successThreshold: number = 2
  ) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.successThreshold = successThreshold;
  }

  /**
   * Check if circuit breaker allows operation
   */
  canExecute(): boolean {
    if (this.state === 'closed') {
      return true;
    }

    if (this.state === 'open') {
      // Try to transition to half-open after timeout
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'half-open';
        this.successCount = 0;
        return true;
      }
      return false;
    }

    // Half-open: allow single request
    return true;
  }

  /**
   * Record success
   */
  recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'closed';
        this.successCount = 0;
      }
    }
  }

  /**
   * Record failure
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  /**
   * Get circuit state
   */
  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }

  /**
   * Reset circuit
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
  }
}
