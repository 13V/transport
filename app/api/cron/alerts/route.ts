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
import { cronAuthFails } from '../../../../lib/cron-auth';
import { detectAndAlert } from '../../../../lib/alerts/detect';

export const dynamic = 'force-dynamic';

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
