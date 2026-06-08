/**
 * MEASURE BURST OUTCOMES CRON ENDPOINT
 *
 * For persisted bursts whose 15m / 1h / 24h horizon has elapsed but isn't yet
 * measured, reads the real candle close nearest that horizon and records the
 * realized return vs the burst baseline. Unmeasurable legs stay NULL.
 *
 *   GET /api/cron/measure-bursts
 *
 * CRON_SECRET-protected when set. Schedule every ~5 minutes; throttles its
 * GeckoTerminal calls and processes a bounded batch per run.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { measureBursts } from '../../../../lib/indexer/burst-outcomes';
import { postResults } from '../../../../lib/alerts/calls';

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

export const maxDuration = 60; // Vercel Hobby caps functions at 60s

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await measureBursts();

    // PUBLIC PROOF FLYWHEEL: auto-post any newly-measured NOTABLE outcomes.
    // Fully env-gated + resilient; wrapped so posting can never fail the cron.
    let postedResults = 0;
    try {
      const r = await postResults();
      postedResults = r.posted;
    } catch (postErr) {
      console.error('[CRON] measure-bursts postResults failed:', postErr);
    }

    return NextResponse.json(
      { ok: true, ...result, postedResults },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[CRON] measure-bursts crashed:', error);
    // Resilient 200: a measurement hiccup must not fail the scheduler.
    return NextResponse.json(
      { ok: false, measured: 0, scanned: 0, error: (error as Error).message },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
