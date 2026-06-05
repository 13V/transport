/**
 * PIPELINE STATUS — one link to see the whole system at a glance.
 *
 *   GET /api/status
 *
 * No manual steps: shows the last indexer + refine runs, how many wallets are
 * indexed, how many clear the smart-money gate, and the current top of the
 * curated list. If this looks healthy, the leaderboard and /api/smart-money/list
 * are good — nothing to paste, nothing to trigger by hand.
 */

import { NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../lib/supabase-client';
import { getSmartCriteria, isSmartWallet } from '../../../lib/indexer/curation';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, error: 'Supabase not configured' }, { status: 503 });
  }

  const supabase = getSupabase();
  const criteria = getSmartCriteria();
  const now = Date.now();

  // Last cron runs (bookkeeping written by the indexer / refine passes).
  const { data: stateRows } = await supabase
    .from('indexer_state')
    .select('key, value, updated_at')
    .in('key', ['last_run', 'last_seed_run']);
  const state: Record<string, unknown> = {};
  for (const r of stateRows ?? []) state[(r as any).key] = (r as any).value;

  // Total indexed wallets.
  const { count: totalWallets } = await supabase
    .from('wallet_stats')
    .select('wallet', { count: 'exact', head: true });

  // Definitive verified count — and whether the migration is even applied.
  const vCount = await supabase
    .from('wallet_stats')
    .select('wallet', { count: 'exact', head: true })
    .eq('verified', true);
  const migrationApplied = !vCount.error;
  const verifiedWallets = vCount.error ? 0 : vCount.count ?? 0;

  // Pull the top of the board to compute how many are "smart" and show a sample.
  const cols =
    'wallet, score, realized_pnl, win_rate, consistency, total_trades, tokens_traded, last_trade_at';
  const extRead = await supabase
    .from('wallet_stats')
    .select(`${cols}, seeded, roi_pct, verified`)
    .order('score', { ascending: false })
    .limit(1000);
  const { data: rows }: { data: any[] | null } = extRead.error
    ? await supabase.from('wallet_stats').select(cols).order('score', { ascending: false }).limit(1000)
    : extRead;

  const smart = (rows ?? []).filter((r: any) =>
    isSmartWallet(
      {
        realizedPnl: Number(r.realized_pnl),
        roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
        winRate: Number(r.win_rate),
        totalTrades: Number(r.total_trades),
        tokensTraded: Number(r.tokens_traded),
        lastTradeAt: r.last_trade_at,
        seeded: Boolean(r.seeded),
      },
      criteria,
      now
    )
  );

  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      lastIndexRun: state.last_run ?? null,
      lastRefineRun: state.last_seed_run ?? null,
      migrationApplied,
      ...(migrationApplied
        ? {}
        : { action: 'Run supabase/schema.sql in the Supabase SQL editor — the roi_pct/verified columns are missing, so nothing can be marked verified/smart.' }),
      totals: {
        walletsIndexed: totalWallets ?? 0,
        smartWallets: smart.length,
        verifiedWallets,
      },
      criteria,
      topSmart: smart.slice(0, 10).map((r: any, i: number) => ({
        rank: i + 1,
        address: r.wallet,
        roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
        pnlSol: Number(r.realized_pnl),
        winRate: Number(r.win_rate),
        trades: Number(r.total_trades),
        verified: Boolean(r.verified),
        seeded: Boolean(r.seeded),
      })),
      links: {
        list: '/api/smart-money/list',
        listAddresses: '/api/smart-money/list?format=addresses',
        listCsv: '/api/smart-money/list?format=csv',
        leaderboard: '/smart-money',
      },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
