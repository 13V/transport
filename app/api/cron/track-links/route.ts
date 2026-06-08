/**
 * LINK TRACKING CRON ENDPOINT
 *
 * Follows SOL out of verified winners to discover the wallets they fund (likely
 * the same trader's new wallets) and enqueues them for tracking forever.
 *
 *   GET /api/cron/track-links
 *
 * CRON_SECRET-protected when set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { runLinkTracking } from '../../../../lib/indexer/run-link-tracking';

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
    const result = await runLinkTracking();
    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[CRON] Link tracking crashed:', error);
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
