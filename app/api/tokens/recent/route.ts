/**
 * RECENTLY-INDEXED COINS
 *
 *   GET /api/tokens/recent
 *
 * Returns the mints the indexer has recently captured swaps for, so you can feed
 * a real (SOL-quoted) coin straight into /api/token/{mint}/traders without
 * hunting for an address. pump.fun mints (ending in "pump") are listed first.
 *
 * Query params:
 *   ?limit=30   how many mints to return (default 30, max 100)
 *   ?pump=1     only pump.fun coins (mints ending in "pump")
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }

  const { searchParams } = request.nextUrl;
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '30', 10) || 30, 1), 100);
  const pumpOnly = searchParams.get('pump') === '1';

  const supabase = getSupabase();
  // Pull a window of recent trades and aggregate by mint in code (one cheap query).
  const { data, error } = await supabase
    .from('trades')
    .select('token_mint, block_time')
    .order('block_time', { ascending: false })
    .limit(5000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const agg = new Map<string, { mint: string; trades: number; lastTradeAt: string }>();
  for (const r of data ?? []) {
    const mint = (r as any).token_mint as string;
    const at = (r as any).block_time as string;
    const cur = agg.get(mint);
    if (cur) cur.trades += 1;
    else agg.set(mint, { mint, trades: 1, lastTradeAt: at });
  }

  let coins = [...agg.values()];
  if (pumpOnly) coins = coins.filter((c) => c.mint.toLowerCase().endsWith('pump'));

  // pump.fun coins first, then by most recently traded.
  coins.sort((a, b) => {
    const ap = a.mint.toLowerCase().endsWith('pump') ? 1 : 0;
    const bp = b.mint.toLowerCase().endsWith('pump') ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.lastTradeAt.localeCompare(a.lastTradeAt);
  });

  const top = coins.slice(0, limit);

  return NextResponse.json(
    {
      count: top.length,
      coins: top.map((c) => ({
        ...c,
        tradersUrl: `/api/token/${c.mint}/traders?winners=1&limit=20`,
      })),
    },
    { headers: { 'Cache-Control': 'public, max-age=120' } }
  );
}
