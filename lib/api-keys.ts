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

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

import { getSupabase, isSupabaseConfigured } from './supabase-client';

export type Tier = 'free' | 'pro';

/**
 * Hash an API key for at-rest storage/lookup. We store ONLY the SHA-256 hash of
 * each key in `api_keys.key` (never the plaintext), so a read of the table — even
 * if RLS were ever bypassed — yields nothing usable. validateApiKey() hashes the
 * presented key and looks it up by this hash, so the wire format is unchanged.
 *
 * Provision/rotate by inserting the HASH, not the raw token:
 *   insert into api_keys (key, ...) values (encode(digest('<raw>','sha256'),'hex'), ...);
 * or hash existing rows in place once (requires pgcrypto):
 *   create extension if not exists pgcrypto;
 *   update api_keys set key = encode(digest(key,'sha256'),'hex')
 *     where key !~ '^[0-9a-f]{64}$';   -- skip already-hashed rows (idempotent)
 */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Constant-time equality for two hex-encoded secrets of equal length. Falls back
 * to a non-matching result on any length mismatch (timingSafeEqual throws on
 * differing lengths) without leaking timing about how far the prefix matched.
 */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Provision a NEW api key and store ONLY its hash (never the plaintext). Returns
 * the raw token to hand to the caller exactly once, plus the stored hash and the
 * expiry. Used by the pay-per-period flow (app/api/access/verify-payment) after
 * an on-chain payment is verified.
 *
 * @param opts.tier        key tier (default 'pro').
 * @param opts.ownerId     attribution (e.g. payer wallet / email).
 * @param opts.label       human label.
 * @param opts.expiresInDays  TTL; the row's expires_at = now + this (default 7).
 *
 * Throws only if Supabase is unconfigured (callers gate on that first).
 */
export async function provisionApiKey(opts: {
  tier?: Tier;
  ownerId?: string | null;
  label?: string | null;
  expiresInDays?: number;
}): Promise<{ rawKey: string; keyHash: string; expiresAt: string }> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase not configured — cannot provision api key');
  }
  const rawKey = `sk_live_${randomBytes(24).toString('hex')}`;
  const keyHash = hashApiKey(rawKey);
  const days = Number.isFinite(opts.expiresInDays) && (opts.expiresInDays as number) > 0
    ? Math.floor(opts.expiresInDays as number)
    : 7;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  // Default label reflects the ACTUAL configured price/period (L-1) rather than
  // a hardcoded '1 SOL/period'. Fall back to the same defaults the pay routes use.
  const labelPriceSol = Number.isFinite(Number(process.env.API_PRICE_SOL))
    && Number(process.env.API_PRICE_SOL) > 0
    ? Number(process.env.API_PRICE_SOL)
    : 1;
  const labelPeriodDays = Number.isFinite(Number(process.env.API_PERIOD_DAYS))
    && Number(process.env.API_PERIOD_DAYS) > 0
    ? Math.floor(Number(process.env.API_PERIOD_DAYS))
    : 7;
  const defaultLabel = `paid (${labelPriceSol} SOL/${labelPeriodDays}d)`;

  const supabase = getSupabase();
  const { error } = await supabase.from('api_keys').insert({
    key: keyHash,
    owner_id: opts.ownerId ?? null,
    tier: (opts.tier ?? 'pro'),
    label: opts.label ?? defaultLabel,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`provisionApiKey insert failed: ${error.message}`);

  return { rawKey, keyHash, expiresAt };
}

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
    // We store only the SHA-256 hash of each key, so look up by hash — the
    // plaintext key never touches the database.
    const keyHash = hashApiKey(key);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('api_keys')
      .select('key, tier, owner_id, expires_at')
      .eq('key', keyHash)
      .maybeSingle();

    if (error || !data) return none;

    // Expiry enforcement (migration 0017): a NULL expires_at means "never
    // expires" (back-compat with manually-provisioned keys); a past timestamp
    // rejects the key as if it were unknown. Paid keys carry now + API_PERIOD.
    const expiresAt = (data as any).expires_at;
    if (expiresAt) {
      const exp = Date.parse(String(expiresAt));
      if (Number.isFinite(exp) && exp <= Date.now()) return none;
    }

    // Defense in depth: confirm the stored hash matches in constant time. The
    // `eq` filter already constrains this, but a direct secret comparison must
    // not short-circuit on the first differing byte.
    const storedHash = String((data as any).key ?? '');
    if (!secretsEqual(storedHash, keyHash)) return none;

    const rawTier = String((data as any).tier || 'free').toLowerCase();
    const tier: Tier = rawTier === 'pro' ? 'pro' : 'free';
    const owner = (data as any).owner_id != null ? String((data as any).owner_id) : null;

    // Best-effort usage stamp — fire and forget, never block or throw.
    void supabase
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('key', keyHash)
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
