/**
 * RISING WALLETS ("MOVERS")
 *
 * Derives which curated smart-money wallets have improved the most over a
 * recent window of daily leaderboard snapshots. "Rising" means climbing the
 * ranks (and, as a tie-break, growing ROI) between a wallet's earliest and
 * latest snapshot in the window.
 *
 * computeMovers is a PURE function over an in-memory set of snapshot rows so it
 * is trivial to unit-test. getMovers wraps it with a resilient Supabase read of
 * the `leaderboard_snapshots` table (see lib/indexer/snapshots.ts), returning []
 * if Supabase is unconfigured or the table is missing.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';

export interface MoverSnapshotInput {
  wallet: string;
  day: string;
  rank: number | null;
  roi_pct: number | null;
}

export interface Mover {
  wallet: string;
  rankDelta: number | null;
  roiDelta: number | null;
  latestRank: number | null;
  latestRoi: number | null;
}

/** UTC day string (YYYY-MM-DD) for a given instant. */
function dayString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Group snapshots by wallet, compare each wallet's earliest vs latest row in
 * the set, and rank by how much they climbed.
 *
 *   rankDelta = earliestRank - latestRank  (positive = climbed toward #1)
 *   roiDelta  = latestRoi    - earliestRoi (positive = ROI grew)
 *
 * Sorted by rankDelta desc (climbers first), tie-broken by roiDelta desc.
 * Wallets with a single snapshot (or insufficient data) yield null deltas and
 * sort to the bottom. Returns the top `limit` (default 50).
 */
export function computeMovers(
  snapshots: MoverSnapshotInput[],
  opts?: { limit?: number }
): Mover[] {
  const limit = opts?.limit ?? 50;

  // Bucket each wallet's rows so we can find its earliest and latest snapshot.
  const byWallet = new Map<string, MoverSnapshotInput[]>();
  for (const s of snapshots) {
    const arr = byWallet.get(s.wallet);
    if (arr) arr.push(s);
    else byWallet.set(s.wallet, [s]);
  }

  const movers: Mover[] = [];
  for (const [wallet, rows] of byWallet) {
    // Chronological order by day string (ISO YYYY-MM-DD sorts lexically).
    const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const earliest = sorted[0];
    const latest = sorted[sorted.length - 1];

    const latestRank = latest.rank;
    const latestRoi = latest.roi_pct;

    // A single snapshot (or only one calendar day) has no movement to measure.
    const hasSpan = sorted.length > 1 && earliest.day !== latest.day;

    const rankDelta =
      hasSpan && earliest.rank != null && latest.rank != null
        ? earliest.rank - latest.rank
        : null;
    const roiDelta =
      hasSpan && earliest.roi_pct != null && latest.roi_pct != null
        ? latest.roi_pct - earliest.roi_pct
        : null;

    movers.push({ wallet, rankDelta, roiDelta, latestRank, latestRoi });
  }

  // Climbers first. Nulls sort last on each key.
  movers.sort((a, b) => {
    const ar = a.rankDelta;
    const br = b.rankDelta;
    if (ar !== br) {
      if (ar == null) return 1;
      if (br == null) return -1;
      return br - ar;
    }
    const ai = a.roiDelta;
    const bi = b.roiDelta;
    if (ai !== bi) {
      if (ai == null) return 1;
      if (bi == null) return -1;
      return bi - ai;
    }
    return 0;
  });

  return movers.slice(0, limit);
}

/**
 * Read recent leaderboard snapshots (day >= today - `days`) and compute the
 * top `limit` rising wallets. Resilient: returns [] when Supabase is
 * unconfigured or the `leaderboard_snapshots` table is missing/unreadable.
 */
export async function getMovers(days = 7, limit = 50): Promise<Mover[]> {
  if (!isSupabaseConfigured()) {
    return [];
  }

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceDay = dayString(since);

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('leaderboard_snapshots')
    .select('wallet, day, rank, roi_pct')
    .gte('day', sinceDay);

  if (error || !data) {
    return [];
  }

  const snapshots: MoverSnapshotInput[] = data.map((r: any) => ({
    wallet: String(r.wallet),
    day: String(r.day),
    rank: r.rank == null ? null : Number(r.rank),
    roi_pct: r.roi_pct == null ? null : Number(r.roi_pct),
  }));

  return computeMovers(snapshots, { limit });
}
