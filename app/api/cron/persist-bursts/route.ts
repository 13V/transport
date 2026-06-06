/**
 * PERSIST LIVE BURSTS CRON ENDPOINT
 *
 * Detects the current smart-money buy bursts and upserts them into live_bursts
 * by their stable content hash, stamping the measurement baseline on first sight.
 *
 *   GET /api/cron/persist-bursts
 *
 * CRON_SECRET-protected when set. Schedule every ~2 minutes so growing bursts
 * are captured (and refreshed) while they're still live.
 */

import { NextRequest, NextResponse } from 'next/server';
import { persistBursts } from '../../../../lib/indexer/burst-outcomes';

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
    const result = await persistBursts();
    return NextResponse.json(
      { ok: true, ...result },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[CRON] persist-bursts crashed:', error);
    // Resilient 200: a persist hiccup must not fail the scheduler.
    return NextResponse.json(
      { ok: false, persisted: 0, error: (error as Error).message },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
