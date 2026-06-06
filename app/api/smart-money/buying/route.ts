/**
 * SMART-MONEY BUYING FEED
 *
 * Surfaces the tokens that multiple VERIFIED smart wallets are buying right now —
 * a "smart money is rotating into X" signal for a terminal feed or alert bot.
 *
 *   GET /api/smart-money/buying                 → JSON { generatedAt, hours, count, tokens[] }
 *   GET /api/smart-money/buying?hours=6         → look back N hours (clamped 1..168)
 *   GET /api/smart-money/buying?limit=20        → cap tokens returned (clamped 1..200)
 *
 * Read-only and public (no CRON_SECRET) — safe to poll. Degrades to an empty
 * token list when Supabase isn't configured or the required columns are missing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSmartMoneyBuys } from '../../../../lib/indexer/smart-buys';
import { getTokenMeta } from '../../../../lib/token-meta';

export const dynamic = 'force-dynamic';

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const v = parseInt(raw || '', 10);
  const n = Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const hours = clampInt(searchParams.get('hours'), 24, 1, 168);
  const limit = clampInt(searchParams.get('limit'), 50, 1, 200);

  const result = await getSmartMoneyBuys({ hours, limit });

  // Enrich tokens with real symbol/name/icon from DexScreener. A metadata
  // failure must never break the feed, so getTokenMeta is resilient and we
  // additionally guard here.
  let tokens: unknown[] = result.tokens;
  try {
    const meta = await getTokenMeta(result.tokens.map((t) => t.mint));
    tokens = result.tokens.map((t) => {
      const m = meta.get(t.mint);
      return m ? { ...t, symbol: m.symbol, name: m.name, icon: m.icon } : t;
    });
  } catch {
    // ignore — return the un-enriched feed
  }

  return NextResponse.json({ ...result, tokens }, {
    headers: { 'Cache-Control': 'public, max-age=60' },
  });
}
