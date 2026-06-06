/**
 * SMART-MONEY BUYING FEED
 *
 * Surfaces the tokens that multiple VERIFIED smart wallets are buying right now —
 * a "smart money is rotating into X" signal for a terminal feed or alert bot.
 *
 *   GET /api/smart-money/buying                 → JSON { generatedAt, hours, count, tokens[] }
 *   GET /api/smart-money/buying?hours=6         → look back N hours (clamped 1..168)
 *   GET /api/smart-money/buying?limit=20        → cap tokens returned (clamped 1..200)
 *   GET /api/smart-money/buying?minBuyers=3     → only tokens with ≥N distinct smart buyers (clamped 1..50)
 *
 * Read-only and public (no CRON_SECRET) — safe to poll. Degrades to an empty
 * token list when Supabase isn't configured or the required columns are missing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSmartMoneyBuys } from '../../../../lib/indexer/smart-buys';
import { getTokenMeta } from '../../../../lib/token-meta';

export const revalidate = 60;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const v = parseInt(raw || '', 10);
  const n = Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const hours = clampInt(searchParams.get('hours'), 24, 1, 168);
  const limit = clampInt(searchParams.get('limit'), 50, 1, 200);
  const hasMinBuyers = searchParams.get('minBuyers') != null;
  const minBuyers = hasMinBuyers ? clampInt(searchParams.get('minBuyers'), 1, 1, 50) : 1;

  const result = await getSmartMoneyBuys({ hours, limit });

  // Optional floor on distinct smart buyers — filter before enrichment so we
  // only pay metadata cost for tokens we actually return.
  const filtered =
    minBuyers > 1
      ? result.tokens.filter((t) => t.distinctSmartBuyers >= minBuyers)
      : result.tokens;

  // Enrich tokens with real symbol/name/icon from DexScreener. A metadata
  // failure must never break the feed, so getTokenMeta is resilient and we
  // additionally guard here.
  let tokens: unknown[] = filtered;
  try {
    const meta = await getTokenMeta(filtered.map((t) => t.mint));
    tokens = filtered.map((t) => {
      const m = meta.get(t.mint);
      if (!m) return t;
      // Surface symbol/name/icon plus the rug/market context now on TokenMeta.
      // Optional-chain so a partially-resolved meta never throws; the client
      // renders only the fields that are present (no fake data).
      return {
        ...t,
        symbol: m.symbol,
        name: m.name,
        icon: m.icon,
        icons: m.icons,
        mintRenounced: m?.mintRenounced,
        freezeRenounced: m?.freezeRenounced,
        pairCreatedAt: m?.pairCreatedAt,
        buys24h: m?.buys24h,
        sells24h: m?.sells24h,
        volume24hUsd: m?.volume24hUsd,
        topHolderPct: m?.topHolderPct,
        marketCapUsd: m?.marketCapUsd,
        liquidityUsd: m?.liquidityUsd,
        priceChange24h: m?.priceChange24h,
        pairAddress: m?.pairAddress,
      };
    });
  } catch {
    // ignore — return the un-enriched feed
  }

  return NextResponse.json({ ...result, count: tokens.length, tokens }, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
  });
}
