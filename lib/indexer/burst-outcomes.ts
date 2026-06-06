/**
 * BURST OUTCOMES — PERSIST + MEASURE + AGGREGATE
 *
 * Turns the ephemeral live burst feed (lib/indexer/live-bursts.ts) into a
 * durable, OUTCOME-PROVEN record: we persist each detected smart-money buy
 * burst, then later measure what the token's price actually did 15m / 1h / 24h
 * after the burst window closed, using REAL candle history. The aggregate
 * (getBurstStats) powers the header stat and social proof ("median +X% 1h,
 * Y% hit rate") so the feed can demonstrably show it calls winners.
 *
 * CRITICAL — NO FABRICATION: every measured number comes from real price
 * history (GeckoTerminal candle closes/highs) compared against a real spot
 * baseline (price_at_burst) stamped at first sight. If a horizon hasn't elapsed,
 * or no candle exists near that timestamp, or the baseline is missing, that leg
 * stays NULL. We never interpolate, guess, or carry a value forward.
 *
 * Everything degrades gracefully: an unconfigured Supabase, a missing table, or
 * a GeckoTerminal outage yields a no-op (counts of 0 / empty stats) rather than
 * throwing, so the crons that call these never crash.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getLiveBursts, type LiveBurst } from './live-bursts';
import { fetchTokenPricesSol } from '../prices/price-oracle';

const GT = 'https://api.geckoterminal.com/api/v2';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Horizon definitions: column suffix, elapsed-ms threshold, label. */
const HORIZONS = [
  { key: '15m' as const, ms: 15 * MIN },
  { key: '1h' as const, ms: HOUR },
  { key: '24h' as const, ms: DAY },
];

interface Candle {
  t: number; // ms
  h: number;
  c: number;
}

// ---------------------------------------------------------------------------
// PERSIST
// ---------------------------------------------------------------------------

/**
 * Detect the current live buy bursts and upsert them by their stable content
 * hash `id`. A still-growing burst (same id, more buyers/SOL) refreshes the
 * existing row; a brand-new burst inserts and gets its measurement baseline
 * (`price_at_burst`) stamped ONCE from real spot price.
 *
 * The growing fields (buyers / buyer_wallets / sol_total / window_end / tiers /
 * sample_buyers / all_buyers / symbol) are always overwritten with the latest
 * values via the upsert. `price_at_burst` and `first_seen` are NOT in the update
 * payload, so an upsert that hits an existing row leaves the original
 * baseline/first-seen intact — only the very first insert sets them. Likewise
 * `posted_call`/`posted_result` are never written here (they default false and
 * are flipped solely by the auto-post agent), so this cron can't un-post a call.
 *
 * Resilient: returns { persisted: 0 } on any unconfigured/missing-table/error.
 */
export async function persistBursts(): Promise<{ persisted: number }> {
  if (!isSupabaseConfigured()) return { persisted: 0 };

  try {
    const supabase = getSupabase();

    const { bursts } = await getLiveBursts({ hours: 2, limit: 200 });
    if (bursts.length === 0) return { persisted: 0 };

    // Which ids already exist? Their baseline must NOT be re-stamped, and we only
    // need spot prices for the genuinely new ones.
    const ids = bursts.map((b) => b.id);
    const existing = new Set<string>();
    const existRead = await supabase
      .from('live_bursts')
      .select('id')
      .in('id', ids);
    if (existRead.error) {
      console.error('[BURSTS] persist read failed:', existRead.error.message);
      return { persisted: 0 };
    }
    for (const r of existRead.data ?? []) existing.add(String((r as any).id));

    // Stamp baselines only for new bursts. Prefer the burst's own priceUsd if
    // present; otherwise fetch real SOL spot. Missing price => baseline stays
    // NULL (the leg simply can't be measured later — never faked).
    const newBursts = bursts.filter((b) => !existing.has(b.id));
    const baselineByMint = new Map<string, number>();
    const needSpot = newBursts
      .filter((b) => !(typeof b.priceUsd === 'number' && b.priceUsd > 0))
      .map((b) => b.mint);
    if (needSpot.length > 0) {
      try {
        const spot = await fetchTokenPricesSol(Array.from(new Set(needSpot)));
        for (const [mint, p] of spot) baselineByMint.set(mint, p);
      } catch {
        /* leave baselines unset for unfetched mints */
      }
    }

    const baselineFor = (b: LiveBurst): number | null => {
      if (typeof b.priceUsd === 'number' && b.priceUsd > 0) return b.priceUsd;
      const p = baselineByMint.get(b.mint);
      return typeof p === 'number' && p > 0 ? p : null;
    };

    // Build upsert rows. For NEW bursts include the baseline columns; for
    // existing ones omit them so onConflict update keeps the original baseline.
    const rows = bursts.map((b) => {
      const base: Record<string, unknown> = {
        id: b.id,
        mint: b.mint,
        side: b.side ?? 'buy',
        symbol: b.symbol ?? null,
        window_start: b.windowStart,
        window_end: b.windowEnd,
        buyers: b.buyers,
        buyer_wallets: b.buyerWallets,
        sol_total: b.solTotal,
        sample_buyers: b.sampleBuyers ?? [],
        tiers: (b.tiers ?? []).map((t) => t ?? ''),
        // Growing field: refresh the full (capped) distinct buyer set as the
        // burst accumulates, for per-wallet attribution. NOTE: posted_call /
        // posted_result are intentionally NOT written here — they default false
        // on insert and are owned by the auto-post agent, so this growth upsert
        // never clobbers them.
        all_buyers: b.allBuyers ?? [],
      };
      if (!existing.has(b.id)) {
        base.price_at_burst = baselineFor(b);
      }
      return base;
    });

    // Upsert by id. Supabase upsert overwrites all provided columns on conflict;
    // since existing-burst rows omit price_at_burst/first_seen, those survive.
    const { error } = await supabase
      .from('live_bursts')
      .upsert(rows, { onConflict: 'id' });
    if (error) {
      console.error('[BURSTS] persist upsert failed:', error.message);
      return { persisted: 0 };
    }

    return { persisted: rows.length };
  } catch (err) {
    console.error('[BURSTS] persist crashed:', (err as Error).message);
    return { persisted: 0 };
  }
}

// ---------------------------------------------------------------------------
// MEASURE
// ---------------------------------------------------------------------------

/**
 * Resolve a token's top GeckoTerminal Solana pool address (the one GT actually
 * has candles for), mirroring app/api/token/[mint]/ohlcv/route.ts. Returns ''
 * when GT has no pools for the mint.
 */
async function resolvePool(mint: string): Promise<string> {
  if (!BASE58.test(mint)) return '';
  try {
    const res = await fetch(
      `${GT}/networks/solana/tokens/${mint}/pools?page=1`,
      { headers: { Accept: 'application/json;version=20230302' } }
    );
    if (!res.ok) return '';
    const data = await res.json();
    const pools = data?.data;
    if (Array.isArray(pools) && pools.length) {
      const addr = pools[0]?.attributes?.address;
      if (typeof addr === 'string' && BASE58.test(addr)) return addr;
    }
  } catch {
    /* no pool */
  }
  return '';
}

/**
 * Pull minute candles for a pool covering the burst window through now, from
 * GeckoTerminal. We use 5-minute aggregation (the same coarse grid the chart
 * uses) which gives ~20h of history per 240-candle page — enough to reach 1h
 * comfortably; for the 24h horizon we additionally fetch hourly candles.
 * Returns ascending-by-time candles, or [] on any failure.
 */
async function fetchCandles(
  pool: string,
  timeframe: 'minute' | 'hour',
  aggregate: number,
  limit: number
): Promise<Candle[]> {
  try {
    const url = `${GT}/networks/solana/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json;version=20230302' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return [];
    return list
      .filter((r: unknown): r is number[] => Array.isArray(r) && r.length >= 6)
      .map((r) => ({ t: Number(r[0]) * 1000, h: +r[2], c: +r[4] }))
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

/**
 * Close of the candle NEAREST a target timestamp, but only if a candle exists
 * within `tolMs` of it (so we never pull a wildly-off price for a gap). Returns
 * null when no candle is close enough — that leg then stays unmeasured.
 */
function closeNear(candles: Candle[], targetMs: number, tolMs: number): number | null {
  let best: Candle | null = null;
  let bestDist = Infinity;
  for (const c of candles) {
    const d = Math.abs(c.t - targetMs);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (!best || bestDist > tolMs) return null;
  return Number.isFinite(best.c) && best.c > 0 ? best.c : null;
}

/** Highest candle high within [fromMs, toMs], or null if no candle in range. */
function peakHigh(candles: Candle[], fromMs: number, toMs: number): number | null {
  let peak: number | null = null;
  for (const c of candles) {
    if (c.t < fromMs || c.t > toMs) continue;
    if (Number.isFinite(c.h) && c.h > 0 && (peak == null || c.h > peak)) peak = c.h;
  }
  return peak;
}

interface BurstRow {
  id: string;
  mint: string;
  price_at_burst: number | null;
  window_end: string;
  ret_15m: number | null;
  ret_1h: number | null;
  ret_24h: number | null;
}

/**
 * Find bursts that have a horizon ELAPSED but its `ret_*` still NULL, then for
 * each read the real candle close nearest that horizon timestamp (and the 24h
 * peak high), compute ret = (priceThen / price_at_burst - 1) * 100, and write
 * the price, ret, peak and measured-at columns for those legs.
 *
 * Throttled: processes a bounded batch of bursts per run and paces GeckoTerminal
 * calls to stay under the free-tier rate limit. Anything unmeasurable stays
 * NULL; nothing is fabricated.
 *
 * Resilient: returns { measured: 0 } on any unconfigured/missing-table/error.
 */
export async function measureBursts(opts?: {
  maxBursts?: number;
}): Promise<{ measured: number; scanned: number }> {
  if (!isSupabaseConfigured()) return { measured: 0, scanned: 0 };

  const maxBursts = opts?.maxBursts ?? 40;

  try {
    const supabase = getSupabase();
    const now = Date.now();

    // Candidates: a baseline exists, the window closed long enough ago for at
    // least the shortest horizon, and at least one ret_* leg is still NULL.
    // (We over-select then filter precisely per horizon below.)
    const oldestNeeded = new Date(now - HORIZONS[0].ms).toISOString();
    const read = await supabase
      .from('live_bursts')
      .select(
        'id, mint, price_at_burst, window_end, ret_15m, ret_1h, ret_24h'
      )
      .not('price_at_burst', 'is', null)
      .lte('window_end', oldestNeeded)
      .or('ret_15m.is.null,ret_1h.is.null,ret_24h.is.null')
      .order('window_end', { ascending: true })
      .limit(maxBursts);

    if (read.error) {
      console.error('[BURSTS] measure read failed:', read.error.message);
      return { measured: 0, scanned: 0 };
    }

    const rows = (read.data ?? []) as BurstRow[];
    if (rows.length === 0) return { measured: 0, scanned: 0 };

    let measured = 0;

    for (const row of rows) {
      const baseline = row.price_at_burst;
      if (!(typeof baseline === 'number' && baseline > 0)) continue;
      const endMs = new Date(row.window_end).getTime();
      if (!Number.isFinite(endMs)) continue;

      // Which legs are due (elapsed) AND not yet measured?
      const dueLegs = HORIZONS.filter((h) => {
        const elapsed = now - endMs >= h.ms;
        const retNull =
          (h.key === '15m' && row.ret_15m == null) ||
          (h.key === '1h' && row.ret_1h == null) ||
          (h.key === '24h' && row.ret_24h == null);
        return elapsed && retNull;
      });
      if (dueLegs.length === 0) continue;

      const pool = await resolvePool(row.mint);
      if (!pool) continue; // no real candles available — leave NULL

      // Fetch a fine grid for 15m/1h legs (5-min candles, ~20h) and, if a 24h
      // leg is due, hourly candles too (covers the 24h reach + peak window).
      const need24h = dueLegs.some((l) => l.key === '24h');
      const fine = await fetchCandles(pool, 'minute', 5, 240);
      await sleep(250); // pace GT calls
      let hourly: Candle[] = [];
      if (need24h) {
        hourly = await fetchCandles(pool, 'hour', 1, 168);
        await sleep(250);
      }

      const update: Record<string, unknown> = {};
      const nowIso = new Date().toISOString();

      for (const leg of dueLegs) {
        const targetMs = endMs + leg.ms;
        // Tolerance scales with the horizon's candle granularity.
        if (leg.key === '15m') {
          const price = closeNear(fine, targetMs, 10 * MIN);
          if (price != null) {
            update.price_15m = price;
            update.ret_15m = (price / baseline - 1) * 100;
            update.measured_15m_at = nowIso;
          }
        } else if (leg.key === '1h') {
          const price = closeNear(fine, targetMs, 20 * MIN);
          if (price != null) {
            update.price_1h = price;
            update.ret_1h = (price / baseline - 1) * 100;
            update.measured_1h_at = nowIso;
          }
        } else if (leg.key === '24h') {
          const price = closeNear(hourly, targetMs, 90 * MIN);
          const peak = peakHigh(hourly, endMs, targetMs);
          if (price != null) {
            update.price_24h = price;
            update.ret_24h = (price / baseline - 1) * 100;
            update.measured_24h_at = nowIso;
          }
          if (peak != null) update.peak_price_24h = peak;
        }
      }

      if (Object.keys(update).length === 0) continue;

      const { error: upErr } = await supabase
        .from('live_bursts')
        .update(update)
        .eq('id', row.id);
      if (upErr) {
        console.error('[BURSTS] measure update failed:', upErr.message);
        continue;
      }
      measured++;
    }

    return { measured, scanned: rows.length };
  } catch (err) {
    console.error('[BURSTS] measure crashed:', (err as Error).message);
    return { measured: 0, scanned: 0 };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// AGGREGATE
// ---------------------------------------------------------------------------

export interface BurstStats {
  /** Total measured bursts considered in the window (always present). */
  n: number;
  /** Bursts first seen in the last 24h (window-independent "today" count). */
  burstsToday: number;
  medianRet1h: number | null;
  hitRate1h: number | null; // % of measured 1h legs with ret_1h > 0
  medianRet24h: number | null;
  hitRate24h: number | null;
  /** Best 24h (fallback 1h) call in the window, by realized return. */
  bestCall: { symbol: string | null; mint: string; ret: number } | null;
  windowHours: number;
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
 * Aggregate measured outcomes over bursts whose window closed within the last
 * `windowHours`. Only legs with REAL non-null data feed each stat; a leg with no
 * measurement is simply excluded from that stat's basis (so the hit-rate is over
 * the measured set, never padded with zeros). `n` is always returned.
 *
 * Resilient: returns a zeroed/empty BurstStats on any error or empty table.
 */
export async function getBurstStats(windowHours = 24): Promise<BurstStats> {
  const empty: BurstStats = {
    n: 0,
    burstsToday: 0,
    medianRet1h: null,
    hitRate1h: null,
    medianRet24h: null,
    hitRate24h: null,
    bestCall: null,
    windowHours,
  };
  if (!isSupabaseConfigured()) return empty;

  try {
    const supabase = getSupabase();
    const now = Date.now();
    const sinceIso = new Date(now - windowHours * HOUR).toISOString();

    const { data, error } = await supabase
      .from('live_bursts')
      .select(
        'mint, symbol, window_end, first_seen, ret_1h, ret_24h'
      )
      .gte('window_end', sinceIso)
      .limit(2000);

    if (error || !data) {
      if (error) console.error('[BURSTS] stats read failed:', error.message);
      return empty;
    }

    const ret1h: number[] = [];
    const ret24h: number[] = [];
    let best: BurstStats['bestCall'] = null;
    let measuredCount = 0;
    const todaySince = now - DAY;

    let burstsToday = 0;
    for (const r of data as any[]) {
      const fs = r.first_seen ? new Date(r.first_seen).getTime() : NaN;
      if (Number.isFinite(fs) && fs >= todaySince) burstsToday++;

      const r1 = r.ret_1h == null ? null : Number(r.ret_1h);
      const r24 = r.ret_24h == null ? null : Number(r.ret_24h);
      const hasMeasure =
        (r1 != null && Number.isFinite(r1)) ||
        (r24 != null && Number.isFinite(r24));
      if (hasMeasure) measuredCount++;

      if (r1 != null && Number.isFinite(r1)) ret1h.push(r1);
      if (r24 != null && Number.isFinite(r24)) ret24h.push(r24);

      // Best call prefers a realized 24h return, falling back to 1h.
      const candidateRet =
        r24 != null && Number.isFinite(r24)
          ? r24
          : r1 != null && Number.isFinite(r1)
          ? r1
          : null;
      if (candidateRet != null && (best == null || candidateRet > best.ret)) {
        best = {
          symbol: r.symbol == null ? null : String(r.symbol),
          mint: String(r.mint),
          ret: round2(candidateRet),
        };
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
      n: measuredCount,
      burstsToday,
      medianRet1h: m1 == null ? null : round2(m1),
      hitRate1h: hit1,
      medianRet24h: m24 == null ? null : round2(m24),
      hitRate24h: hit24,
      bestCall: best,
      windowHours,
    };
  } catch (err) {
    console.error('[BURSTS] stats crashed:', (err as Error).message);
    return empty;
  }
}
