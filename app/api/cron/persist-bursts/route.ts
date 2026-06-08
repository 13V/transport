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
import { timingSafeEqual } from 'crypto';
import { persistBursts } from '../../../../lib/indexer/burst-outcomes';
import { postNewCalls } from '../../../../lib/alerts/calls';

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
    const result = await persistBursts();

    // PUBLIC PROOF FLYWHEEL: auto-post any newly-fired high-conviction calls.
    // Fully env-gated + resilient; wrapped so posting can never fail the cron.
    let postedCalls = 0;
    try {
      const r = await postNewCalls();
      postedCalls = r.posted;
    } catch (postErr) {
      console.error('[CRON] persist-bursts postNewCalls failed:', postErr);
    }

    return NextResponse.json(
      { ok: true, ...result, postedCalls },
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
