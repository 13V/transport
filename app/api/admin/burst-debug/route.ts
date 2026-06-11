/**
 * BURST BASELINE DEBUG
 *
 * Root-cause tool for corrupted outcome baselines: the public stats keep
 * surfacing bestCall rows whose stored price_at_burst sits ~10-1000x below any
 * plausible launch price, inflating measured returns. This dumps everything
 * needed to see WHERE a given mint's baseline came from:
 *
 *   - its live_bursts rows (baseline, ret legs, window, type)
 *   - the underlying trades rows (price = sol_amount/amount per row, so a
 *     decimals slip in `amount` shows up as an absurd per-row price)
 *
 *   GET /api/admin/burst-debug?mint=<mint>   (Authorization: Bearer <CRON_SECRET>)
 *
 * Read-only, secret-gated, no writes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  const mint = (request.nextUrl.searchParams.get('mint') || '').trim();
  if (!MINT_RE.test(mint)) return NextResponse.json({ error: 'invalid mint' }, { status: 400 });
  const supabase = getSupabase();

  const bursts = await supabase
    .from('live_bursts')
    .select('*')
    .eq('mint', mint)
    .order('window_end', { ascending: false })
    .limit(10);

  const trades = await supabase
    .from('trades')
    .select('wallet, trade_type, amount, price, sol_amount, block_time, source, tx_hash')
    .eq('token_mint', mint)
    .order('block_time', { ascending: true })
    .limit(50);

  return NextResponse.json({
    mint,
    bursts: bursts.error ? { error: bursts.error.message } : bursts.data,
    trades: trades.error ? { error: trades.error.message } : trades.data,
  });
}
