/**
 * PER-WALLET TRACK RECORD — VERIFIABLE, MEASURED CALLS
 *
 * A wallet's track record is its REAL participation in smart-money buy bursts
 * whose forward outcomes we later MEASURED from actual price history (see
 * lib/indexer/burst-outcomes.ts). For a given wallet we find every persisted
 * burst whose distinct buyer set (`all_buyers`, migration 0009) contains the
 * wallet, then aggregate only the legs that have a real, non-null measured
 * return.
 *
 * CRITICAL — NO FABRICATION: every number here is derived from a measured
 * `ret_1h` / `ret_24h` leg that burst-outcomes.ts wrote from real candles. A
 * burst the wallet was in but whose horizon hasn't been measured simply doesn't
 * contribute to that stat. `n` is the count of bursts the wallet participated in
 * that have at least one measured leg, and is ALWAYS returned (0 when none).
 *
 * Resilient: an unconfigured Supabase, a missing table/column, or any query
 * error yields an empty-but-shaped record ({ n: 0, ... }) rather than throwing,
 * so the API route and UI never break.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface WalletRecordCall {
  symbol: string | null;
  mint: string;
  ret: number;
}

export interface WalletRecentCall {
  symbol: string | null;
  mint: string;
  windowEnd: string | null;
  ret1h: number | null;
  ret24h: number | null;
}

export interface WalletRecord {
  address: string;
  /** Bursts the wallet was in that have at least one measured leg. Always present. */
  n: number;
  medianRet1h: number | null;
  hitRate1h: number | null; // % of measured 1h legs with ret_1h > 0
  medianRet24h: number | null;
  hitRate24h: number | null;
  /** Best measured call (prefers 24h, falls back to 1h), by realized return. */
  bestCall: WalletRecordCall | null;
  /** Worst measured call (prefers 24h, falls back to 1h), by realized return. */
  worstCall: WalletRecordCall | null;
  /** Latest ~10 measured bursts the wallet participated in. */
  recentCalls: WalletRecentCall[];
  windowDays: number;
}

function emptyRecord(address: string, windowDays: number): WalletRecord {
  return {
    address,
    n: 0,
    medianRet1h: null,
    hitRate1h: null,
    medianRet24h: null,
    hitRate24h: null,
    bestCall: null,
    worstCall: null,
    recentCalls: [],
    windowDays,
  };
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute a wallet's measured track record over bursts whose window closed
 * within the last `windowDays`. Only real, non-null measured legs feed each
 * stat; an unmeasured leg is simply excluded (hit-rate is over the measured set,
 * never padded). `n` is always returned.
 */
export async function getWalletRecord(
  address: string,
  windowDays = 90
): Promise<WalletRecord> {
  if (!isSupabaseConfigured()) return emptyRecord(address, windowDays);

  try {
    const supabase = getSupabase();
    const sinceIso = new Date(Date.now() - windowDays * DAY).toISOString();

    // Bursts whose distinct buyer set contains this wallet (GIN-indexed
    // all_buyers @> [address]), within the window. We over-select then keep only
    // measured legs below.
    const { data, error } = await supabase
      .from('live_bursts')
      .select('mint, symbol, window_end, ret_1h, ret_24h')
      .contains('all_buyers', [address])
      .gte('window_end', sinceIso)
      .order('window_end', { ascending: false })
      .limit(2000);

    if (error || !data) {
      if (error) console.error('[WALLET-RECORD] read failed:', error.message);
      return emptyRecord(address, windowDays);
    }

    const ret1h: number[] = [];
    const ret24h: number[] = [];
    let best: WalletRecordCall | null = null;
    let worst: WalletRecordCall | null = null;
    let measuredCount = 0;
    const recentCalls: WalletRecentCall[] = [];

    for (const r of data as any[]) {
      const r1 = r.ret_1h == null ? null : Number(r.ret_1h);
      const r24 = r.ret_24h == null ? null : Number(r.ret_24h);
      const has1 = r1 != null && Number.isFinite(r1);
      const has24 = r24 != null && Number.isFinite(r24);
      const hasMeasure = has1 || has24;
      if (!hasMeasure) continue; // only bursts with a real measured leg count

      measuredCount++;
      if (has1) ret1h.push(r1 as number);
      if (has24) ret24h.push(r24 as number);

      const mint = String(r.mint);
      const symbol = r.symbol == null ? null : String(r.symbol);

      // recentCalls is the latest ~10 (data is window_end desc).
      if (recentCalls.length < 10) {
        recentCalls.push({
          symbol,
          mint,
          windowEnd: r.window_end == null ? null : String(r.window_end),
          ret1h: has1 ? round2(r1 as number) : null,
          ret24h: has24 ? round2(r24 as number) : null,
        });
      }

      // Best / worst prefer a realized 24h return, falling back to 1h.
      const candidateRet = has24 ? (r24 as number) : has1 ? (r1 as number) : null;
      if (candidateRet != null) {
        if (best == null || candidateRet > best.ret) {
          best = { symbol, mint, ret: round2(candidateRet) };
        }
        if (worst == null || candidateRet < worst.ret) {
          worst = { symbol, mint, ret: round2(candidateRet) };
        }
      }
    }

    const m1 = median(ret1h);
    const m24 = median(ret24h);
    const hit1 =
      ret1h.length > 0
        ? round2((ret1h.filter((x) => x > 0).length / ret1h.length) * 100)
        : null;
    const hit24 =
      ret24h.length > 0
        ? round2((ret24h.filter((x) => x > 0).length / ret24h.length) * 100)
        : null;

    return {
      address,
      n: measuredCount,
      medianRet1h: m1 == null ? null : round2(m1),
      hitRate1h: hit1,
      medianRet24h: m24 == null ? null : round2(m24),
      hitRate24h: hit24,
      bestCall: best,
      worstCall: worst,
      recentCalls,
      windowDays,
    };
  } catch (err) {
    console.error('[WALLET-RECORD] crashed:', (err as Error).message);
    return emptyRecord(address, windowDays);
  }
}
