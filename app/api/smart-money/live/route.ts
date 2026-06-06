/**
 * SMART-MONEY LIVE BURST FEED
 *
 * Surfaces "buy bursts" — moments where ≥N distinct smart-money entities bought
 * the SAME token inside a short window (default 30s). The live, time-sensitive
 * counterpart to /api/smart-money/buying: "smart money just piled into X."
 *
 *   GET /api/smart-money/live                  → JSON { generatedAt, windowSec, minBuyers, count, bursts[] }
 *   GET /api/smart-money/live?windowSec=30     → burst window in seconds (clamped 5..300)
 *   GET /api/smart-money/live?minBuyers=3      → distinct entities required to fire (clamped 2..20)
 *   GET /api/smart-money/live?hours=6          → look-back window (clamped 1..48)
 *   GET /api/smart-money/live?limit=50         → cap bursts returned (clamped 1..200)
 *
 * Read-only and public (no CRON_SECRET) — safe to poll. Must feel live, so it's
 * force-dynamic with only a short edge cache. Degrades to an empty burst list
 * when Supabase isn't configured or the required columns are missing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getLiveBursts } from '../../../../lib/indexer/live-bursts';
import { getTokenMeta } from '../../../../lib/token-meta';

export const dynamic = 'force-dynamic';

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const v = parseInt(raw || '', 10);
  const n = Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const windowSec = clampInt(searchParams.get('windowSec'), 30, 5, 300);
  const minBuyers = clampInt(searchParams.get('minBuyers'), 3, 2, 20);
  const hours = clampInt(searchParams.get('hours'), 6, 1, 48);
  const limit = clampInt(searchParams.get('limit'), 50, 1, 200);

  const result = await getLiveBursts({ windowSec, minBuyers, hours, limit });

  // Enrich bursts with real symbol/name/icon from DexScreener/Helius. A
  // metadata failure must never break the feed, so getTokenMeta is resilient
  // and we additionally guard here.
  let bursts = result.bursts;
  try {
    const meta = await getTokenMeta(bursts.map((b) => b.mint));
    bursts = bursts.map((b) => {
      const m = meta.get(b.mint);
      return m
        ? { ...b, symbol: m.symbol, name: m.name, icon: m.icon, icons: m.icons }
        : b;
    });
  } catch {
    // ignore — return the un-enriched feed
  }

  return NextResponse.json(
    { ...result, count: bursts.length, bursts },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30',
      },
    }
  );
}
