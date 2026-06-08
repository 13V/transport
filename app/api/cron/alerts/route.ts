/**
 * ALERTS CRON ENDPOINT
 *
 * Scans recently-indexed smart-money flow and fires:
 *   - BUY / accumulation alerts (smart money rotating in)
 *   - SELL / distribution alerts (smart money exiting) — distinct cooldown
 *   - optional legacy funding-link alerts (ALERT_FUNDING=1)
 * to the configured channels (Telegram private + optional public, webhook).
 *
 *   GET /api/cron/alerts
 *
 * CRON_SECRET-protected when set.
 *
 * NOTE: the daily "top movers" digest (sendDailyDigest in lib/alerts/detect.ts)
 * is intentionally NOT called here — this tick runs too often for a once-a-day
 * digest. Add a separate daily cron entry to wire it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { detectAndAlert } from '../../../../lib/alerts/detect';

export const dynamic = 'force-dynamic';

/**
 * Cron auth — FAILS CLOSED. Returns true (= reject) when CRON_SECRET is unset OR
 * the Authorization header does not match `Bearer <secret>`. Constant-time,
 * length-guarded compare.
 */
function cronAuthFails(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = request.headers.get('authorization') ?? '';
  const a = Buffer.from(auth);
  const b = Buffer.from(`Bearer ${secret}`);
  if (a.length !== b.length) return true;
  return !timingSafeEqual(a, b);
}

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await detectAndAlert();
    return NextResponse.json(
      { ok: true, ...result },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[CRON] Alerts crashed:', error);
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
