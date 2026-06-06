/**
 * API KEYS — validation + soft rate limiting for the paid real-time surface.
 *
 * The public polling endpoints stay free and key-less. The push-based SSE feed
 * (/api/smart-money/live/stream) calls validateApiKey() and REQUIRES a key that
 * resolves to a row in the `api_keys` table (see migration 0005). The resolved
 * `tier` picks the per-key rate limit from TIER_LIMITS.
 *
 * Everything here is best-effort and resilient: if Supabase isn't configured or
 * the `api_keys` table doesn't exist yet, validation simply returns "no key"
 * rather than throwing, so the rest of the app is unaffected.
 */

import { getSupabase, isSupabaseConfigured } from './supabase-client';

export type Tier = 'free' | 'pro';

export interface ApiKeyResult {
  valid: boolean;
  tier: Tier | null;
  owner: string | null;
}

/**
 * Per-tier soft limits for the SSE stream, expressed as (max connections-or-
 * requests within windowMs) keyed by api key. These reset on cold start, which
 * is acceptable for a soft limit guarding a long-lived streaming endpoint.
 */
export const TIER_LIMITS: Record<Tier, { limit: number; windowMs: number }> = {
  // Free keys exist (e.g. an upgraded-then-downgraded key) but get a tight cap.
  free: { limit: 6, windowMs: 60_000 },
  // Pro: generous — a bot may reconnect frequently (maxDuration forces ~60s
  // reconnects) across a few processes without tripping the limiter.
  pro: { limit: 120, windowMs: 60_000 },
};

/** Pull the raw key from `Authorization: Bearer <key>` or a `?key=` param. */
function extractKey(req: Request): string | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('key');
    if (q) return q.trim();
  } catch {
    // malformed url — ignore
  }
  return null;
}

/**
 * Look up the presented key in `api_keys`. Returns {valid:false} for a missing/
 * unknown key and degrades to the same on any error (no Supabase, missing
 * table, etc.) so callers can uniformly reject without special-casing infra.
 * Best-effort stamps last_used_at; a stamp failure never affects the result.
 */
export async function validateApiKey(req: Request): Promise<ApiKeyResult> {
  const none: ApiKeyResult = { valid: false, tier: null, owner: null };

  const key = extractKey(req);
  if (!key) return none;
  if (!isSupabaseConfigured()) return none;

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('api_keys')
      .select('key, tier, owner_id')
      .eq('key', key)
      .maybeSingle();

    if (error || !data) return none;

    const rawTier = String((data as any).tier || 'free').toLowerCase();
    const tier: Tier = rawTier === 'pro' ? 'pro' : 'free';
    const owner = (data as any).owner_id != null ? String((data as any).owner_id) : null;

    // Best-effort usage stamp — fire and forget, never block or throw.
    void supabase
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('key', key)
      .then(
        () => undefined,
        () => undefined
      );

    return { valid: true, tier, owner };
  } catch {
    return none;
  }
}

/**
 * Simple in-memory sliding-window rate limiter, per key. Module-level Map of
 * key -> recent hit timestamps. Returns true if the hit is ALLOWED, false if it
 * exceeds `limit` within the trailing `windowMs`. Best-effort: state is
 * per-process and resets on cold start, which is fine for a soft limit.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = (hits.get(key) || []).filter((t) => t > cutoff);
  if (arr.length >= limit) {
    hits.set(key, arr); // keep the pruned list so it doesn't grow unbounded
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}
