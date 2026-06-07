/**
 * RISING WALLETS ("MOVERS") FEED
 *
 * Surfaces the curated smart-money wallets that have climbed the leaderboard
 * the most over a recent window, derived from daily snapshot history.
 *
 *   GET /api/smart-money/movers                 → JSON { generatedAt, days, count, movers }
 *   GET /api/smart-money/movers?days=7&limit=50 → tune the window and cap
 *
 * Read-only and public — safe to poll. Degrades gracefully: if Supabase is
 * unconfigured or the snapshots table is missing, returns an empty movers list.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMovers } from '../../../../lib/indexer/movers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const days = Math.min(Math.max(parseInt(searchParams.get('days') || '7', 10) || 7, 1), 365);
  const limit = Math.min(
    Math.max(parseInt(searchParams.get('limit') || '50', 10) || 50, 1),
    1000
  );

  const movers = await getMovers(days, limit);

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      days,
      count: movers.length,
      movers,
    },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } }
  );
}
