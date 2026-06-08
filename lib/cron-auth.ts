/**
 * SHARED CRON AUTH — single source of truth for protecting cron + ingest routes.
 *
 * Dependency-free: only Node's built-in `crypto` and the `NextRequest` type.
 *
 * FAILS CLOSED: if `CRON_SECRET` is unset/blank, EVERY request is rejected.
 * Beyond that, it is deliberately TOLERANT of the common setup mistakes that
 * cause silent 401s during mobile setup:
 *
 *   1. A trailing space / newline accidentally pasted into the Vercel
 *      `CRON_SECRET` env value — the #1 cause. We `.trim()` the env secret
 *      (and every presented value) before comparing.
 *
 *   2. The secret can be presented EITHER of these ways (each constant-time,
 *      length-guarded compared against the trimmed secret):
 *        a. `Authorization: Bearer <secret>`  (Vercel Cron sends this)
 *        b. `Authorization: <secret>`         (raw header, no `Bearer ` prefix)
 *
 *      The secret is read ONLY from the Authorization header — never from a
 *      query string — so it can't leak into access logs / referrers.
 *
 * Returns `true` when auth FAILS (caller should reject with 401), `false` when
 * the request is authorized.
 */

import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

/**
 * Constant-time, length-guarded equality. Returns false fast on length mismatch
 * (length is not secret here), otherwise compares the full buffers in constant
 * time to avoid leaking the secret via timing.
 */
function secretEquals(presented: string, secret: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Cron auth check. Returns `true` if the request should be REJECTED (auth
 * failed) and `false` if it is authorized. See file header for the accepted
 * forms and the fail-closed behavior.
 */
export function cronAuthFails(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return true; // fail closed: no secret configured → reject all

  // Collect every place a caller might present the secret.
  const candidates: string[] = [];

  const auth = request.headers.get('authorization');
  if (auth) {
    // Accept both `Bearer <secret>` and a raw `<secret>` Authorization header.
    // The secret is intentionally NOT accepted via query string — that would
    // leak CRON_SECRET into access logs / proxy logs / referrer headers.
    candidates.push(auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth);
    candidates.push(auth);
  }

  // Authorized if ANY presented value matches the (trimmed) secret.
  for (const candidate of candidates) {
    if (secretEquals(candidate.trim(), secret)) return false;
  }

  return true; // nothing matched → reject
}
