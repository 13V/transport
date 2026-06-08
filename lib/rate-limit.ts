/**
 * IN-PROCESS PER-IP RATE LIMITER (best-effort).
 *
 * A tiny fixed-window counter keyed by client IP (`x-forwarded-for`, falling
 * back to `x-real-ip`). Mirrors the limiter already inlined in
 * `app/api/analyze/route.ts`, lifted here so the expensive public read routes
 * (ohlcv batch / ohlcv / smart-money live + ui-stream) can share it.
 *
 * IMPORTANT — SCOPE/LIMITATIONS:
 *   - PER-INSTANCE: state lives in this module's memory. On a multi-instance /
 *     serverless deployment each instance keeps its own counters, so the
 *     effective global limit is (limit × instances). This is a cheap guardrail
 *     against a single client hammering one instance, NOT a hard global quota.
 *   - BEST-EFFORT: a process restart / cold start resets all windows.
 *   - For a hard, shared limit you'd back this with Redis/Upstash; intentionally
 *     out of scope here (no new infra).
 *
 * Two primitives:
 *   - `rateLimit(bucket, ip, max, windowMs)` — fixed-window request counter.
 *   - `concurrencyLimit(...)` — for SSE: cap simultaneous open connections per
 *     IP, returning a `release()` to call when the stream closes.
 */

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

type Window = { count: number; resetTime: number };

// bucket name -> (ip -> window). Separate buckets so different endpoints don't
// share counters.
const BUCKETS = new Map<string, Map<string, Window>>();

// ip -> open SSE connection count, per bucket.
const CONCURRENCY = new Map<string, Map<string, number>>();

function bucket(name: string): Map<string, Window> {
  let b = BUCKETS.get(name);
  if (!b) {
    b = new Map();
    BUCKETS.set(name, b);
  }
  return b;
}

// Periodic sweep of expired windows so the maps don't grow unbounded. Guarded so
// it only schedules once per process and never blocks shutdown.
declare global {
  // eslint-disable-next-line no-var
  var __rateLimitCleanup: ReturnType<typeof setInterval> | undefined;
}
if (typeof globalThis !== 'undefined' && !globalThis.__rateLimitCleanup) {
  const t = setInterval(() => {
    const now = Date.now();
    for (const b of BUCKETS.values()) {
      for (const [ip, w] of b.entries()) {
        if (now > w.resetTime) b.delete(ip);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't keep the event loop alive just for cleanup.
  if (typeof t.unref === 'function') t.unref();
  globalThis.__rateLimitCleanup = t;
}

/** Resolve the client IP from forwarding headers; 'unknown' as a shared bucket. */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    // x-forwarded-for may be a comma-separated list; the first hop is the client.
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') || 'unknown';
}

export type RateLimitResult = {
  ok: boolean;
  /** Seconds until the current window resets (for Retry-After). */
  retryAfter: number;
};

/**
 * Fixed-window counter. Returns ok=false once `max` requests have been made by
 * `ip` within `windowMs`. Normal polling should sit comfortably under `max`.
 */
export function rateLimit(
  bucketName: string,
  ip: string,
  max: number,
  windowMs: number = RATE_LIMIT_WINDOW_MS
): RateLimitResult {
  const b = bucket(bucketName);
  const now = Date.now();
  const w = b.get(ip);

  if (!w || now > w.resetTime) {
    b.set(ip, { count: 1, resetTime: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }

  if (w.count >= max) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((w.resetTime - now) / 1000)) };
  }

  w.count++;
  return { ok: true, retryAfter: 0 };
}

export type ConcurrencySlot = {
  ok: boolean;
  /** Suggested Retry-After seconds when the cap is hit. */
  retryAfter: number;
  /** Releases the slot. Safe to call once; no-op if not acquired. */
  release: () => void;
};

/**
 * Concurrency cap for long-lived connections (SSE). Acquires a slot for `ip`
 * within `bucketName`; returns ok=false (with a Retry-After) once `max` slots
 * are already open. The returned `release()` MUST be called when the stream
 * closes/aborts so the slot is freed.
 */
export function concurrencyLimit(
  bucketName: string,
  ip: string,
  max: number,
  retryAfterSec = 10
): ConcurrencySlot {
  let m = CONCURRENCY.get(bucketName);
  if (!m) {
    m = new Map();
    CONCURRENCY.set(bucketName, m);
  }
  const cur = m.get(ip) ?? 0;
  if (cur >= max) {
    return { ok: false, retryAfter: retryAfterSec, release: () => {} };
  }
  m.set(ip, cur + 1);
  let released = false;
  return {
    ok: true,
    retryAfter: 0,
    release: () => {
      if (released) return;
      released = true;
      const map = CONCURRENCY.get(bucketName);
      if (!map) return;
      const n = (map.get(ip) ?? 1) - 1;
      if (n <= 0) map.delete(ip);
      else map.set(ip, n);
    },
  };
}
