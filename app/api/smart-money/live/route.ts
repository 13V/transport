/**
 * SMART-MONEY LIVE BURST FEED
 *
 * Surfaces "buy bursts" — moments where ≥N distinct smart-money entities bought
 * the SAME token inside a short window (default 30s). The live, time-sensitive
 * counterpart to /api/smart-money/buying: "smart money just piled into X."
 *
 *   GET /api/smart-money/live                  → JSON { generatedAt, windowSec, minBuyers, count, nextCursor, bursts[] }
 *   GET /api/smart-money/live?windowSec=30     → burst window in seconds (clamped 5..300)
 *   GET /api/smart-money/live?minBuyers=3      → distinct entities required to fire (clamped 2..20)
 *   GET /api/smart-money/live?hours=6          → look-back window (clamped 1..48)
 *   GET /api/smart-money/live?limit=50         → cap bursts returned (clamped 1..200)
 *   GET /api/smart-money/live?sort=quality     → ranking: quality (default) | recent (legacy)
 *   GET /api/smart-money/live?minSol=0         → only bursts with solTotal >= minSol
 *   GET /api/smart-money/live?since=<iso|ms>   → only bursts with windowEnd > since (bot polling)
 *
 * Read-only and public (no CRON_SECRET) — safe to poll. Must feel live, so it's
 * force-dynamic with only a short edge cache. Degrades to an empty burst list
 * when Supabase isn't configured or the required columns are missing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildLiveFeed } from '../../../../lib/indexer/live-feed';

export const dynamic = 'force-dynamic';

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const v = parseInt(raw || '', 10);
  const n = Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

function clampFloat(raw: string | null, fallback: number, min: number, max: number): number {
  const v = parseFloat(raw || '');
  const n = Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

/** Parse a `since` cursor that may be ISO-8601 or epoch-ms; null if unparseable. */
function parseSince(raw: string | null): number | null {
  if (!raw) return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const windowSec = clampInt(searchParams.get('windowSec'), 30, 5, 300);
  const minBuyers = clampInt(searchParams.get('minBuyers'), 3, 2, 20);
  const hours = clampInt(searchParams.get('hours'), 6, 1, 48);
  const limit = clampInt(searchParams.get('limit'), 50, 1, 200);
  const sort = searchParams.get('sort') === 'recent' ? 'recent' : 'quality';
  const minSol = clampFloat(searchParams.get('minSol'), 0, 0, Number.MAX_SAFE_INTEGER);
  const sinceMs = parseSince(searchParams.get('since'));

  // All filter/sort/cap/enrich logic now lives in buildLiveFeed, served from a
  // short result cache shared with the SSE stream route. Same shape as before.
  const result = await buildLiveFeed({
    windowSec,
    minBuyers,
    hours,
    limit,
    sort,
    minSol,
    sinceMs,
  });

  return NextResponse.json(
    result,
    {
      headers: {
        // Short s-maxage so the feed is near-real-time; the CDN still coalesces
        // bursts of polls across users to one origin hit per ~2s, bounding DB load.
        'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10',
      },
    }
  );
}
