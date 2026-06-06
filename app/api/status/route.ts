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
import { fetchAllRows } from '../../../lib/db-paginate';

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

  // Compute how many wallets are "smart" at scale. Rather than fetch top-N by
  // score and filter in JS (which under-counts once verified wallets exceed N),
  // push the CHEAP gate conditions into the query so only plausible-smart rows
  // come back — that set is small even as the table grows, so a generous limit
  // is safe. The remaining nuance (bot-filter, maxWinRate cap) is applied in JS
  // below so the final set is byte-identical to the gate.
  const cols =
    'wallet, score, realized_pnl, win_rate, consistency, total_trades, tokens_traded, last_trade_at';
  // Build a FRESH gate query per page (Supabase builders are single-use).
  const buildGate = () => {
    let qb = supabase
      .from('wallet_stats')
      .select(`${cols}, seeded, roi_pct, invested_sol, verified`)
      .not('roi_pct', 'is', null)
      .gte('roi_pct', criteria.minRoiPct)
      .gte('realized_pnl', criteria.minPnlSol)
      .gte('total_trades', criteria.minTrades)
      .gte('tokens_traded', criteria.minTokens);
    if (criteria.minInvestedSol > 0) {
      qb = qb.gte('invested_sol', criteria.minInvestedSol);
    }
    if (criteria.maxIdleDays > 0) {
      const cutoff = new Date(now - criteria.maxIdleDays * 86_400_000).toISOString();
      qb = qb.gte('last_trade_at', cutoff);
    }
    return qb.order('score', { ascending: false });
  };
  // PostgREST caps a single response at ~1000 rows, so .limit(20000) silently
  // clamps and the smart count pins at 1000 once it grows past that. Page through
  // with .range() to get the TRUE full gate-passing set.
  const extRead = await fetchAllRows(buildGate);

  // Degraded / pre-migration fallback: if the roi_pct/verified columns (or the
  // gate filters above) aren't available, fall back to the original top-N + JS.
  const rows: any[] | null = extRead.error
    ? (await supabase.from('wallet_stats').select(cols).order('score', { ascending: false }).range(0, 999)).data
    : extRead.data;

  const smart = (rows ?? []).filter((r: any) =>
    isSmartWallet(
      {
        realizedPnl: Number(r.realized_pnl),
        roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
        investedSol: r.invested_sol == null ? null : Number(r.invested_sol),
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
