/**
 * SIGNAL BACKTESTER — "how did bursts matching THESE criteria perform?"
 *
 * Answers, strictly from the MEASURED outcome table (live_bursts, migrations
 * 0008 + 0009), the question a skeptical user actually wants: if I'd only acted
 * on smart-money bursts that cleared a quality bar (≥N buyers, ≥X SOL, ≥k S/A
 * tier wallets, multi-entity, a given side), what did the token do 15m / 1h /
 * 24h later — in median, hit-rate, and best/worst realized return?
 *
 * CRITICAL — NO FABRICATION: every number is derived from real `ret_*` columns
 * that lib/indexer/burst-outcomes.ts measured from real candle history. A leg
 * that was never measured (ret_* NULL) is simply EXCLUDED from that leg's basis;
 * it is never counted as 0. `n` is the count of rows matching the filters in the
 * window (whether or not any horizon has been measured yet), so an honest "we
 * have matches but no outcomes yet" is distinguishable from "no matches".
 *
 * Resilient: an unconfigured Supabase, a missing table/column, or a query error
 * yields an empty-but-shaped result rather than throwing, so the API and page
 * degrade to a clean NULL/empty state.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** All filters optional. Defaults applied by the caller / runBacktest. */
export interface BacktestFilters {
  /** Minimum distinct smart-money ENTITIES in the burst. */
  minBuyers?: number;
  /** Minimum total SOL committed across the burst. */
  minSol?: number;
  /** Minimum count of 'S'-tier wallets in tiers[]. */
  minSTier?: number;
  /** Minimum count of 'A'-tier wallets in tiers[]. */
  minATier?: number;
  /** Require a multi-entity burst (buyers ≈ buyer_wallets, i.e. not one wallet
   *  fronting many). True = each entity is its own wallet (independent crowd). */
  requireMultiEntity?: boolean;
  /** Trade side. */
  side?: 'buy' | 'sell';
  /** Lookback window in days (by window_end). Default 30. */
  windowDays?: number;
}

/** One bucket of the realized-return distribution (a 1h-return histogram). */
export interface DistBucket {
  /** Human label for the bucket range, e.g. "0→25%". */
  bucket: string;
  count: number;
}

/** Outcome breakdown grouped by the burst's buyer (entity) count. */
export interface ByBuyerCount {
  buyers: number;
  n: number;
  medianRet1h: number | null;
}

/** A single notable call (best/worst realized return in the matched set). */
export interface BacktestCall {
  symbol: string | null;
  mint: string;
  ret: number;
  /** Which horizon the ret came from ('24h' preferred, else '1h', else '15m'). */
  horizon: '15m' | '1h' | '24h';
}

export interface BacktestResult {
  /** Rows matching the filters in the window (always present, may be 0). */
  n: number;
  medianRet15m: number | null;
  hitRate15m: number | null;
  avgRet15m: number | null;
  medianRet1h: number | null;
  hitRate1h: number | null;
  avgRet1h: number | null;
  medianRet24h: number | null;
  hitRate24h: number | null;
  avgRet24h: number | null;
  /** Count of rows with at least one measured horizon. */
  measured: number;
  bestCall: BacktestCall | null;
  worstCall: BacktestCall | null;
  distribution: DistBucket[];
  byBuyerCount: ByBuyerCount[];
  /** Echo of the effective filters used (post-clamp), for the UI. */
  filters: Required<Pick<BacktestFilters, 'windowDays'>> & BacktestFilters;
}

interface Row {
  mint: string;
  symbol: string | null;
  side: string | null;
  buyers: number | null;
  buyer_wallets: number | null;
  sol_total: number | null;
  tiers: string[] | null;
  ret_15m: number | null;
  ret_1h: number | null;
  ret_24h: number | null;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Count tier letters (case-insensitive) in a tiers array. */
function countTier(tiers: string[] | null | undefined, letter: 'S' | 'A'): number {
  if (!Array.isArray(tiers)) return 0;
  let c = 0;
  for (const t of tiers) {
    if (typeof t === 'string' && t.trim().toUpperCase() === letter) c++;
  }
  return c;
}

/**
 * Fixed histogram edges for the 1h-return distribution (percent). Symmetric
 * around 0 with a wide-tail catch-all at each end so a single moonshot doesn't
 * blow the axis. Bucketing is purely a presentation of REAL returns.
 */
const DIST_EDGES = [-50, -25, -10, 0, 10, 25, 50, 100];

function bucketLabelFor(value: number): string {
  // Below the first edge.
  if (value < DIST_EDGES[0]) return `<${DIST_EDGES[0]}%`;
  for (let i = 0; i < DIST_EDGES.length - 1; i++) {
    if (value < DIST_EDGES[i + 1]) {
      const lo = DIST_EDGES[i];
      const hi = DIST_EDGES[i + 1];
      return `${lo}→${hi}%`;
    }
  }
  return `≥${DIST_EDGES[DIST_EDGES.length - 1]}%`;
}

/** Ordered list of every bucket label (so empty buckets still render as 0). */
function allBucketLabels(): string[] {
  const labels: string[] = [`<${DIST_EDGES[0]}%`];
  for (let i = 0; i < DIST_EDGES.length - 1; i++) {
    labels.push(`${DIST_EDGES[i]}→${DIST_EDGES[i + 1]}%`);
  }
  labels.push(`≥${DIST_EDGES[DIST_EDGES.length - 1]}%`);
  return labels;
}

function emptyResult(filters: BacktestResult['filters']): BacktestResult {
  return {
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
    distribution: allBucketLabels().map((bucket) => ({ bucket, count: 0 })),
    byBuyerCount: [],
    filters,
  };
}

/**
 * Run the backtest. Pull measured rows whose window closed inside the lookback,
 * push the SQL-expressible filters to the DB, finish the array-shaped filters
 * (tier counts, multi-entity) in memory, then aggregate every horizon over only
 * the legs that have REAL data.
 */
export async function runBacktest(filters: BacktestFilters = {}): Promise<BacktestResult> {
  const windowDays = Math.max(1, Math.min(filters.windowDays ?? 30, 365));
  const eff: BacktestResult['filters'] = { ...filters, windowDays };

  if (!isSupabaseConfigured()) return emptyResult(eff);

  try {
    const supabase = getSupabase();
    const sinceIso = new Date(Date.now() - windowDays * DAY).toISOString();

    let query = supabase
      .from('live_bursts')
      .select(
        'mint, symbol, side, buyers, buyer_wallets, sol_total, tiers, ret_15m, ret_1h, ret_24h'
      )
      .gte('window_end', sinceIso)
      .order('window_end', { ascending: false })
      .limit(5000);

    // Push the numeric / scalar filters to the DB.
    if (filters.side === 'buy' || filters.side === 'sell') {
      query = query.eq('side', filters.side);
    }
    if (typeof filters.minBuyers === 'number' && filters.minBuyers > 0) {
      query = query.gte('buyers', filters.minBuyers);
    }
    if (typeof filters.minSol === 'number' && filters.minSol > 0) {
      query = query.gte('sol_total', filters.minSol);
    }

    const { data, error } = await query;
    if (error || !data) {
      if (error) console.error('[BACKTEST] read failed:', error.message);
      return emptyResult(eff);
    }

    const rows = data as unknown as Row[];

    // Array-shaped filters (tier counts, multi-entity) finished in memory — these
    // can't be expressed cheaply in PostgREST against a text[] column.
    const matched = rows.filter((r) => {
      if (typeof filters.minSTier === 'number' && filters.minSTier > 0) {
        if (countTier(r.tiers, 'S') < filters.minSTier) return false;
      }
      if (typeof filters.minATier === 'number' && filters.minATier > 0) {
        if (countTier(r.tiers, 'A') < filters.minATier) return false;
      }
      if (filters.requireMultiEntity) {
        const buyers = num(r.buyers) ?? 0;
        const wallets = num(r.buyer_wallets) ?? 0;
        // Independent crowd: at least 2 entities and roughly one-wallet-per-entity
        // (not a single wallet fanning out across many sub-wallets).
        if (!(buyers >= 2 && wallets <= buyers + 1)) return false;
      }
      return true;
    });

    const n = matched.length;
    if (n === 0) return emptyResult(eff);

    const ret15: number[] = [];
    const ret1h: number[] = [];
    const ret24: number[] = [];
    let measured = 0;
    let best: BacktestCall | null = null;
    let worst: BacktestCall | null = null;

    // Distribution over the 1h leg (the headline horizon).
    const distCounts = new Map<string, number>();
    for (const label of allBucketLabels()) distCounts.set(label, 0);

    // By-buyer-count aggregation (1h median per distinct buyer count).
    const byBuyer = new Map<number, number[]>(); // buyers → ret_1h[]
    const byBuyerN = new Map<number, number>(); // buyers → matched row count

    for (const r of matched) {
      const r15 = num(r.ret_15m);
      const r1 = num(r.ret_1h);
      const r24 = num(r.ret_24h);
      if (r15 != null) ret15.push(r15);
      if (r1 != null) ret1h.push(r1);
      if (r24 != null) ret24.push(r24);
      if (r15 != null || r1 != null || r24 != null) measured++;

      // Distribution uses the 1h leg only (most-measured, comparable horizon).
      if (r1 != null) {
        const label = bucketLabelFor(r1);
        distCounts.set(label, (distCounts.get(label) ?? 0) + 1);
      }

      // By buyer count.
      const bc = num(r.buyers);
      if (bc != null && bc > 0) {
        byBuyerN.set(bc, (byBuyerN.get(bc) ?? 0) + 1);
        if (r1 != null) {
          const arr = byBuyer.get(bc) ?? [];
          arr.push(r1);
          byBuyer.set(bc, arr);
        }
      }

      // Best/worst by the strongest-available realized horizon (24h>1h>15m).
      const horizon: BacktestCall['horizon'] | null =
        r24 != null ? '24h' : r1 != null ? '1h' : r15 != null ? '15m' : null;
      const candRet = r24 ?? r1 ?? r15 ?? null;
      if (horizon != null && candRet != null) {
        const call: BacktestCall = {
          symbol: r.symbol == null ? null : String(r.symbol),
          mint: String(r.mint),
          ret: round2(candRet),
          horizon,
        };
        if (best == null || call.ret > best.ret) best = call;
        if (worst == null || call.ret < worst.ret) worst = call;
      }
    }

    const hitRate = (arr: number[]): number | null =>
      arr.length > 0 ? round2((arr.filter((x) => x > 0).length / arr.length) * 100) : null;
    const med = (arr: number[]): number | null => {
      const m = median(arr);
      return m == null ? null : round2(m);
    };
    const avg = (arr: number[]): number | null => {
      const m = mean(arr);
      return m == null ? null : round2(m);
    };

    const distribution: DistBucket[] = allBucketLabels().map((bucket) => ({
      bucket,
      count: distCounts.get(bucket) ?? 0,
    }));

    const byBuyerCount: ByBuyerCount[] = Array.from(byBuyerN.keys())
      .sort((a, b) => a - b)
      .map((buyers) => ({
        buyers,
        n: byBuyerN.get(buyers) ?? 0,
        medianRet1h: med(byBuyer.get(buyers) ?? []),
      }));

    return {
      n,
      medianRet15m: med(ret15),
      hitRate15m: hitRate(ret15),
      avgRet15m: avg(ret15),
      medianRet1h: med(ret1h),
      hitRate1h: hitRate(ret1h),
      avgRet1h: avg(ret1h),
      medianRet24h: med(ret24),
      hitRate24h: hitRate(ret24),
      avgRet24h: avg(ret24),
      measured,
      bestCall: best,
      worstCall: worst,
      distribution,
      byBuyerCount,
      filters: eff,
    };
  } catch (err) {
    console.error('[BACKTEST] crashed:', (err as Error).message);
    return emptyResult(eff);
  }
}
