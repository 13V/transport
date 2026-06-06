/**
 * LEADERBOARD SNAPSHOT CRON ENDPOINT
 *
 * Captures a daily snapshot of the curated smart-money leaderboard so the
 * product can show ROI/rank over time and surface rising wallets.
 *
 *   GET /api/cron/snapshot
 *
 * CRON_SECRET-protected when set. Schedule once per day (UTC).
 */

import { NextRequest, NextResponse } from 'next/server';
import { snapshotLeaderboard } from '../../../../lib/indexer/snapshots';

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
    const result = await snapshotLeaderboard();
    return NextResponse.json(
      { ok: true, ...result },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[CRON] Leaderboard snapshot crashed:', error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
