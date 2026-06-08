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
import { cronAuthFails } from '../../../../lib/cron-auth';
import { runLinkTracking } from '../../../../lib/indexer/run-link-tracking';

export const dynamic = 'force-dynamic';

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
