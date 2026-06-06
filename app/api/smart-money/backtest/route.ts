/**
 * SIGNAL BACKTESTER API
 *
 * Public, read-only: "historically, how did smart-money bursts matching THESE
 * criteria perform?" Parses the filter query params, clamps them sanely, runs
 * the backtest against the MEASURED outcome table (lib/indexer/backtest.ts), and
 * returns the aggregate JSON. Every number is real or NULL — never fabricated.
 *
 *   GET /api/smart-money/backtest
 *     ?minBuyers=int  &minSol=float  &minSTier=int  &minATier=int
 *     &multiEntity=1  &side=buy|sell  &windowDays=int(1..365, default 30)
 *
 * Degrades to an empty-but-shaped result on any error so the page never breaks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runBacktest, type BacktestFilters } from '@/lib/indexer/backtest';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

/** Parse a clamped non-negative integer query param, or undefined when absent. */
function intParam(v: string | null, max: number): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(Math.floor(n), max));
}

/** Parse a clamped non-negative float query param, or undefined when absent. */
function floatParam(v: string | null, max: number): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(n, max));
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  const sideRaw = sp.get('side');
  const side: BacktestFilters['side'] =
    sideRaw === 'buy' || sideRaw === 'sell' ? sideRaw : undefined;

  const windowDaysRaw = intParam(sp.get('windowDays'), 365);

  const filters: BacktestFilters = {
    minBuyers: intParam(sp.get('minBuyers'), 1000),
    minSol: floatParam(sp.get('minSol'), 1_000_000),
    minSTier: intParam(sp.get('minSTier'), 100),
    minATier: intParam(sp.get('minATier'), 100),
    requireMultiEntity: sp.get('multiEntity') === '1' || sp.get('multiEntity') === 'true',
    side,
    windowDays: windowDaysRaw == null || windowDaysRaw < 1 ? 30 : windowDaysRaw,
  };

  try {
    const result = await runBacktest(filters);
    return NextResponse.json(result, { headers: { 'Cache-Control': CACHE } });
  } catch (error) {
    console.error('[BACKTEST] route crashed:', error);
    // Empty-but-shaped degrade. runBacktest already shapes empties, so this is a
    // last-resort safety net for an unexpected throw.
    return NextResponse.json(
      {
        n: 0,
        medianRet15m: null,
        hitRate15m: null,
        avgRet15m: null,
        medianRet1h: null,
        hitRate1h: null,
        avgRet1h: null,
        medianRet24h: null,
        hitRate24h: null,
        avgRet24h: null,
        measured: 0,
        bestCall: null,
        worstCall: null,
        distribution: [],
        byBuyerCount: [],
        filters,
      },
      { headers: { 'Cache-Control': CACHE } }
    );
  }
}
