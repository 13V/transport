/**
 * SMART-MONEY LIVE BURST STATS
 *
 * Public, social-proof header stat for the live burst feed: how many bursts,
 * the median realized return, the hit rate, and the best call — all measured
 * from REAL price history (see lib/indexer/burst-outcomes.ts). Legs with no
 * measurement are excluded, never faked; `n` is always returned.
 *
 *   GET /api/smart-money/live/stats              → getBurstStats(24)
 *   GET /api/smart-money/live/stats?hours=72     → window in hours (clamped 1..720)
 *
 * Read-only and public. Short edge cache (these aggregates only move on the
 * measure cron's cadence). Degrades to a zeroed/empty stats object on any error.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getBurstStats } from '../../../../../lib/indexer/burst-outcomes';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const raw = Number(request.nextUrl.searchParams.get('hours'));
  const hours = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 720)) : 24;

  try {
    const stats = await getBurstStats(hours);
    return NextResponse.json(stats, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    });
  } catch (error) {
    console.error('[STATS] live burst stats crashed:', error);
    // Degrade to an empty-but-shaped payload so the header never breaks.
    return NextResponse.json(
      {
        n: 0,
        burstsToday: 0,
        medianRet1h: null,
        hitRate1h: null,
        medianRet24h: null,
        hitRate24h: null,
        bestCall: null,
        windowHours: hours,
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        },
      }
    );
  }
}
