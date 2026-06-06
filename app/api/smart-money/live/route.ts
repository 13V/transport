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
import { getLiveBursts, qualityScore, type LiveBurst } from '../../../../lib/indexer/live-bursts';
import { getTokenMeta } from '../../../../lib/token-meta';

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

  // Pull more than `limit` so post-filtering (minSol/since) + re-ranking still
  // has a full pool to cap from; the underlying limit is clamped to 200.
  const result = await getLiveBursts({ windowSec, minBuyers, hours, limit: 200 });

  // Apply caller filters, then rank, then cap to the requested limit.
  let bursts: LiveBurst[] = result.bursts.filter((b) => {
    if (b.solTotal < minSol) return false;
    if (sinceMs != null && new Date(b.windowEnd).getTime() <= sinceMs) return false;
    return true;
  });

  bursts.sort((a, b) => {
    if (sort === 'recent') {
      return new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime();
    }
    // quality: composite desc, recency as tiebreak.
    const q = qualityScore(b) - qualityScore(a);
    if (q !== 0) return q;
    return new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime();
  });

  bursts = bursts.slice(0, limit);

  // Cursor for bot polling: the newest windowEnd across the (pre-limit) filtered
  // set, so a follower can pass it back as ?since= and only get newer bursts.
  let nextCursor: string | null = null;
  for (const b of result.bursts) {
    if (b.solTotal < minSol) continue;
    if (!nextCursor || new Date(b.windowEnd).getTime() > new Date(nextCursor).getTime()) {
      nextCursor = b.windowEnd;
    }
  }

  // Enrich bursts with real symbol/name/icon + live market stats from
  // DexScreener/Helius. A metadata failure must never break the feed, so
  // getTokenMeta is resilient and we additionally guard here.
  try {
    const meta = await getTokenMeta(bursts.map((b) => b.mint));
    bursts = bursts.map((b) => {
      const m = meta.get(b.mint);
      if (!m) return b;
      // Read newer TokenMeta fields loosely: another agent is adding these to
      // TokenMeta in parallel, so access them off a loose alias with optional
      // chaining. Safe (undefined) even before the fields land on the type.
      const mx = m as Record<string, unknown>;
      return {
        ...b,
        symbol: m.symbol,
        name: m.name,
        icon: m.icon,
        icons: m.icons,
        marketCapUsd: m.marketCapUsd,
        liquidityUsd: m.liquidityUsd,
        priceChange24h: m.priceChange24h,
        priceUsd: m.priceUsd,
        pairAddress: m.pairAddress,
        mintRenounced: mx?.mintRenounced as boolean | undefined,
        freezeRenounced: mx?.freezeRenounced as boolean | undefined,
        pairCreatedAt: mx?.pairCreatedAt as number | undefined,
        buys24h: mx?.buys24h as number | undefined,
        sells24h: mx?.sells24h as number | undefined,
        volume24hUsd: mx?.volume24hUsd as number | undefined,
        topHolderPct: mx?.topHolderPct as number | undefined,
      };
    });
  } catch {
    // ignore — return the un-enriched feed
  }

  return NextResponse.json(
    { ...result, count: bursts.length, nextCursor, bursts },
    {
      headers: {
        // Short s-maxage so the feed is near-real-time; the CDN still coalesces
        // bursts of polls across users to one origin hit per ~2s, bounding DB load.
        'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10',
      },
    }
  );
}
