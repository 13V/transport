/**
 * LEADERBOARD SNAPSHOTS
 *
 * Captures a daily point-in-time snapshot of the curated smart-money
 * leaderboard so the product can show ROI and rank over time and surface
 * "rising" wallets (those climbing the ranks).
 *
 * One row per wallet per day (upsert on wallet+day), so re-running the cron
 * within the same UTC day refreshes that day's snapshot rather than duplicating.
 *
 * Everything degrades gracefully: if Supabase is unconfigured or the
 * `leaderboard_snapshots` table is missing, snapshotLeaderboard returns
 * { captured: 0 } and getWalletHistory returns { snapshots: [] } instead of
 * throwing.
 *
 * Table DDL (see snapshots README / report):
 *   create table if not exists leaderboard_snapshots (
 *     wallet text not null,
 *     day date not null,
 *     rank integer,
 *     score double precision,
 *     roi_pct double precision,
 *     realized_pnl double precision,
 *     captured_at timestamptz not null default now(),
 *     primary key (wallet, day)
 *   );
 *   create index if not exists leaderboard_snapshots_day_idx on leaderboard_snapshots (day);
 *   create index if not exists leaderboard_snapshots_wallet_idx on leaderboard_snapshots (wallet);
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getBroadSmartCriteria, isSmartWallet } from './curation';

/** How many top-scored verified wallets to consider before curation. */
const READ_LIMIT = 500;

/** UTC day string (YYYY-MM-DD) for a given instant. */
function dayString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export interface WalletHistoryPoint {
  day: string;
  rank: number | null;
  score: number | null;
  roiPct: number | null;
  realizedPnl: number | null;
}

/**
 * Read the verified wallets, filter to smart-money, rank by score desc, and
 * upsert one snapshot row per wallet for today (UTC). Resilient to a missing
 * table or unconfigured Supabase — returns { captured: 0 } in those cases.
 */
export async function snapshotLeaderboard(): Promise<{ captured: number }> {
  if (!isSupabaseConfigured()) {
    return { captured: 0 };
  }

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('wallet_stats')
    .select(
      'wallet, score, roi_pct, realized_pnl, win_rate, total_trades, tokens_traded, last_trade_at, verified, seeded, invested_sol'
    )
    .eq('verified', true)
    .order('score', { ascending: false })
    .limit(READ_LIMIT);

  if (error || !data) {
    console.error('[SNAPSHOT] Failed to read wallet_stats:', error?.message);
    return { captured: 0 };
  }

  // INCLUSION uses the BROAD gate so the snapshot covers the broadened set.
  const criteria = getBroadSmartCriteria();
  const now = Date.now();

  // Filter to smart-money, then rank by score desc among the survivors.
  const smart = data
    .filter((r: any) =>
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
    )
    .sort((a: any, b: any) => Number(b.score) - Number(a.score));

  if (smart.length === 0) {
    return { captured: 0 };
  }

  const capturedAt = new Date().toISOString();
  const day = dayString();

  const rows = smart.map((r: any, i: number) => ({
    wallet: r.wallet as string,
    rank: i + 1,
    score: r.score == null ? null : Number(r.score),
    roi_pct: r.roi_pct == null ? null : Number(r.roi_pct),
    realized_pnl: r.realized_pnl == null ? null : Number(r.realized_pnl),
    captured_at: capturedAt,
    day,
  }));

  const { error: upsertError } = await supabase
    .from('leaderboard_snapshots')
    .upsert(rows, { onConflict: 'wallet,day' });

  if (upsertError) {
    console.error('[SNAPSHOT] Upsert failed (table missing?):', upsertError.message);
    return { captured: 0 };
  }

  return { captured: rows.length };
}

/**
 * Read a single wallet's snapshot history ordered oldest-to-newest, limited to
 * the most recent `days` rows. Resilient to missing table / unconfigured DB.
 */
export async function getWalletHistory(
  address: string,
  days = 90
): Promise<{ snapshots: WalletHistoryPoint[] }> {
  if (!isSupabaseConfigured()) {
    return { snapshots: [] };
  }

  const supabase = getSupabase();
  const limit = Math.max(1, Math.min(days, 3650));

  // Fetch the most recent `days` rows (day desc), then return ascending so the
  // caller gets a chronological series ready to chart.
  const { data, error } = await supabase
    .from('leaderboard_snapshots')
    .select('day, rank, score, roi_pct, realized_pnl')
    .eq('wallet', address)
    .order('day', { ascending: false })
    .limit(limit);

  if (error || !data) {
    return { snapshots: [] };
  }

  const snapshots: WalletHistoryPoint[] = data
    .map((r: any) => ({
      day: String(r.day),
      rank: r.rank == null ? null : Number(r.rank),
      score: r.score == null ? null : Number(r.score),
      roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
      realizedPnl: r.realized_pnl == null ? null : Number(r.realized_pnl),
    }))
    .reverse(); // day asc

  return { snapshots };
}
