/**
 * CRON: PRUNE OLD TRADES
 *
 *   GET /api/cron/prune-trades
 *
 * Deletes raw `trades` rows older than the retention window so the table — and
 * therefore Disk IO for scans/writes/vacuum — stays bounded on small Supabase
 * compute (Nano: 43 Mbps baseline). Safe because the leaderboard reads
 * precomputed `wallet_stats` and live features only look back hours; old raw
 * trades are dead weight.
 *
 * Retention is TRADES_RETENTION_DAYS (default 14). CRON_SECRET-protected when
 * set. Run daily. The delete uses the trades(block_time) index, so steady-state
 * runs (≈one day of rows) are cheap. Do the FIRST bulk cleanup of a large
 * backlog manually in the SQL editor — a single huge delete here could exceed
 * the function timeout and roll back.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function retentionDays(): number {
  const n = Number(process.env.TRADES_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const days = retentionDays();

  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { ok: false, reason: 'supabase-not-configured', retentionDays: days },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const supabase = getSupabase();

    // Single indexed delete (trades(block_time) idx). Steady-state this is ~one
    // day of rows. count:'estimated' avoids an extra exact-count scan.
    const { error, count } = await supabase
      .from('trades')
      .delete({ count: 'estimated' })
      .lt('block_time', cutoff);

    if (error) {
      console.error('[CRON] prune-trades delete failed:', error.message);
      return NextResponse.json(
        { ok: false, error: error.message, retentionDays: days, cutoff },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      { ok: true, deleted: count ?? null, retentionDays: days, cutoff },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[CRON] prune-trades crashed:', error);
    // Resilient 200: a prune hiccup must not fail the scheduler.
    return NextResponse.json(
      { ok: false, error: (error as Error).message, retentionDays: days },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
