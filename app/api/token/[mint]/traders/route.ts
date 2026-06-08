/**
 * PER-COIN TRADERS + PnL
 *
 *   GET /api/token/{mint}/traders
 *
 * Pulls a coin's full swap history and ranks every wallet that bought/sold it
 * by realized PnL on that coin. This is the smart-money discovery method made
 * inspectable: pick a coin → see who won.
 *
 * Query params:
 *   ?max=600         transactions to scan (default 600, max 2000)
 *   ?limit=100       traders to return (default 100)
 *   ?sort=total      rank by total|realized PnL (default total)
 *   ?min_pnl=0       only wallets with PnL (by the sort metric) >= this (SOL)
 *   ?winners=1       shorthand for PnL just above 0
 */

import { NextRequest, NextResponse } from 'next/server';
import { analyzeTokenTraders } from '../../../../../lib/indexer/token-traders';
import { rateLimit, clientIp } from '../../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Per-IP cap: each call pulls a coin's full swap history (expensive Helius
// spend), so keep it tight — a handful per minute covers legitimate browsing.
const RL_MAX = 15;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mint: string }> }
) {
  const rl = rateLimit('token-traders', clientIp(request), RL_MAX);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  const { mint } = await params;

  if (!mint || mint.length < 32 || mint.length > 64) {
    return NextResponse.json({ error: 'Invalid mint address' }, { status: 400 });
  }
  if (!process.env.HELIUS_API_KEY) {
    return NextResponse.json(
      { error: 'HELIUS_API_KEY missing — cannot fetch swaps' },
      { status: 503 }
    );
  }

  const { searchParams } = request.nextUrl;
  const max = Math.min(Math.max(parseInt(searchParams.get('max') || '600', 10) || 600, 100), 2000);
  // Cap the returned list hard (50) — the token page only renders the top ~25,
  // and a fat trader array is pure payload weight on the heaviest page.
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10) || 50, 1), 100);
  const sort = searchParams.get('sort') === 'realized' ? 'realized' : 'total';
  const metric = (t: { totalPnl: number; realizedPnl: number }) =>
    sort === 'realized' ? t.realizedPnl : t.totalPnl;
  const winners = searchParams.get('winners') === '1';
  const minPnl = winners
    ? 1e-9
    : Number(searchParams.get('min_pnl') ?? Number.NEGATIVE_INFINITY);

  try {
    const result = await analyzeTokenTraders(mint, max);
    const ranked =
      sort === 'realized'
        ? [...result.traders].sort((a, b) => b.realizedPnl - a.realizedPnl)
        : result.traders; // already total-sorted
    const filtered = ranked.filter((t) => metric(t) >= minPnl).slice(0, limit);

    return NextResponse.json(
      {
        mint: result.mint,
        txScanned: result.txScanned,
        traderCount: result.traderCount,
        markPrice: result.markPrice,
        sort,
        returned: filtered.length,
        traders: filtered,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } }
    );
  } catch (error) {
    console.error(`[TRADERS] failed for ${mint}:`, error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
