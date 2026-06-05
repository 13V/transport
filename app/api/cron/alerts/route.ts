/**
 * ALERTS CRON ENDPOINT
 *
 * Scans recently-indexed data and fires alerts for new smart-wallet BUYs and new
 * funding links to the configured channels (Telegram / webhook).
 *
 *   GET /api/cron/alerts
 *
 * CRON_SECRET-protected when set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { detectAndAlert } from '../../../../lib/alerts/detect';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
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
