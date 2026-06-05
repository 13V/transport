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
 *   ?max=600      transactions to scan (default 600, max 2000)
 *   ?limit=100    traders to return (default 100)
 *   ?min_pnl=0    only return wallets with realized PnL >= this (SOL)
 *   ?winners=1    shorthand for min_pnl just above 0
 */

import { NextRequest, NextResponse } from 'next/server';
import { analyzeTokenTraders } from '../../../../../lib/indexer/token-traders';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mint: string }> }
) {
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
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '100', 10) || 100, 1), 500);
  const winners = searchParams.get('winners') === '1';
  const minPnl = winners
    ? 1e-9
    : Number(searchParams.get('min_pnl') ?? Number.NEGATIVE_INFINITY);

  try {
    const result = await analyzeTokenTraders(mint, max);
    const filtered = result.traders.filter((t) => t.realizedPnl >= minPnl).slice(0, limit);

    return NextResponse.json(
      {
        mint: result.mint,
        txScanned: result.txScanned,
        traderCount: result.traderCount,
        returned: filtered.length,
        traders: filtered,
      },
      { headers: { 'Cache-Control': 'public, max-age=120' } }
    );
  } catch (error) {
    console.error(`[TRADERS] failed for ${mint}:`, error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
