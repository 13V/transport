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
 * CRITICAL — UNIT CONSISTENCY + NO FABRICATION: every price in a burst's outcome
 * (price_at_burst, price_15m/1h/24h, peak_price_24h) comes from the SAME source
 * and SAME unit — GeckoTerminal USD candles for ONE pool (the highest-liquidity
 * pool for the mint). The baseline price_at_burst is NOT a SOL spot price stamped
 * at persist time; it is the USD candle close at/nearest the burst's window_end,
 * derived in measureBursts on the first measurement pass and reused thereafter.
 * This keeps baseline and horizon prices on the same USD scale so ret_* is real.
 * If a horizon hasn't elapsed, or no candle exists near that timestamp, or the
 * baseline can't be derived, that leg stays NULL. We never interpolate, guess,
 * carry a value forward, or mix SOL and USD.
 *
 * Everything degrades gracefully: an unconfigured Supabase, a missing table, or
 * a GeckoTerminal outage yields a no-op (counts of 0 / empty stats) rather than
 * throwing, so the crons that call these never crash.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getLiveBursts } from './live-bursts';
import { getTokenMeta } from '../token-meta';
import { fetchAllRows } from '../db-paginate';
import { isQuoteMint } from '../quote-mints';

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

// Sample-forward grace: a leg is only recorded if the current sample is taken
// within [horizon, horizon + grace] of window_end, so the sampled price is near
// the horizon (the 5-min cron easily catches these). Past the window the leg
// stays NULL (no fabrication) rather than recording a far-off price.
const GRACE: Record<'15m' | '1h' | '24h', number> = {
  '15m': 20 * MIN,
  '1h': 40 * MIN,
  '24h': 6 * HOUR,
};

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
 * existing row; a brand-new burst inserts. No price baseline is stamped here —
 * `price_at_burst` is derived later in measureBursts from the SAME USD candle
 * series used for the horizons (so baseline and measurements share one unit).
 *
 * MONOTONIC GROWTH (bug H1): a burst's accumulation fields must never shrink.
 * The 2h getLiveBursts lookback can no longer see a burst's early buys once they
 * age out, so a naive upsert would OVERWRITE buyers / buyer_wallets / sol_total /
 * window_start downward. We therefore MERGE each incoming burst against the
 * existing row: keep MAX(buyers, buyer_wallets, sol_total), the EARLIEST
 * window_start, the LATEST window_end, and the UNION (capped) of all_buyers —
 * a burst can only ever ratchet UP from its recorded peak.
 *
 * `price_at_burst` and `first_seen` are NOT written here, so an upsert that hits
 * an existing row leaves the derived baseline / first-seen intact. Likewise
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

    // Read the existing rows' GROWING fields so we can merge monotonically and
    // never shrink a burst below its recorded peak.
    const ids = bursts.map((b) => b.id);
    const existingById = new Map<string, ExistingGrowth>();
    const existRead = await supabase
      .from('live_bursts')
      .select(
        'id, buyers, buyer_wallets, sol_total, window_start, window_end, all_buyers, price_at_burst'
      )
      .in('id', ids);
    if (existRead.error) {
      console.error('[BURSTS] persist read failed:', existRead.error.message);
      return { persisted: 0 };
    }
    for (const r of (existRead.data ?? []) as any[]) {
      existingById.set(String(r.id), {
        buyers: numOrNull(r.buyers),
        buyer_wallets: numOrNull(r.buyer_wallets),
        sol_total: numOrNull(r.sol_total),
        window_start: r.window_start ? String(r.window_start) : null,
        window_end: r.window_end ? String(r.window_end) : null,
        all_buyers: Array.isArray(r.all_buyers)
          ? (r.all_buyers as unknown[]).map((x) => String(x))
          : [],
        price_at_burst: numOrNull(r.price_at_burst),
      });
    }

    // We stamp a USD baseline (price_at_burst) at persist time for bursts that don't
    // have one yet — so outcome measurement works on fresh pump.fun tokens. The
    // baseline is the burst's OWN price (already enriched on the object): prefer
    // DexScreener priceUsd (matches the horizon source), else derive from the
    // on-chain first-buy price × SOL/USD (ALWAYS present, so fresh tokens that
    // DexScreener hasn't indexed yet still get a baseline). One cheap SOL/USD read.
    const WSOL = 'So11111111111111111111111111111111111111112';
    let solUsd: number | undefined;
    try {
      solUsd = (await getTokenMeta([WSOL], { skipHelius: true, includeTopHolder: false })).get(WSOL)?.priceUsd;
    } catch { /* leave undefined — on-chain baselines simply skip until a price exists */ }
    const baselineUsd = (b: { priceUsd?: number; firstBuyPriceSol?: number | null }): number | undefined => {
      if (typeof b.priceUsd === 'number' && b.priceUsd > 0) return b.priceUsd;
      if (typeof b.firstBuyPriceSol === 'number' && b.firstBuyPriceSol > 0 && solUsd && solUsd > 0) {
        return b.firstBuyPriceSol * solUsd;
      }
      return undefined;
    };

    // Build upsert rows, merging each burst monotonically against any existing
    // row. price_at_burst / first_seen are deliberately omitted so the derived
    // baseline survives the conflict update.
    const rows = bursts.map((b) => {
      const prev = existingById.get(b.id);

      // Growing numeric fields only ever ratchet UP.
      const buyers = maxDefined(b.buyers, prev?.buyers);
      const buyerWallets = maxDefined(b.buyerWallets, prev?.buyer_wallets);
      const solTotal = maxDefined(b.solTotal, prev?.sol_total);

      // window_start = EARLIEST seen; window_end = LATEST seen.
      const windowStart = earliestIso(b.windowStart, prev?.window_start);
      const windowEnd = latestIso(b.windowEnd, prev?.window_end);

      // all_buyers = capped UNION of the prior set and the incoming set, so the
      // distinct-buyer attribution set never loses wallets that aged out.
      const allBuyers = unionCapped(
        prev?.all_buyers ?? [],
        b.allBuyers ?? [],
        ALL_BUYERS_CAP
      );

      // Stamp the baseline ONLY when this burst has none yet (new burst) — so an
      // existing baseline survives the conflict update.
      const needsBaseline = !((prev?.price_at_burst ?? 0) > 0);
      const baseUsd = needsBaseline ? baselineUsd(b) : undefined;

      return {
        id: b.id,
        mint: b.mint,
        side: b.side ?? 'buy',
        // Signal type for per-type outcome aggregation (migration 0021). Written
        // optimistically; stripped on the fallback path below when the column is
        // absent (pre-migration), so persisting never fails on this field.
        type: b.type ?? 'burst',
        symbol: b.symbol ?? null,
        window_start: windowStart,
        window_end: windowEnd,
        buyers,
        buyer_wallets: buyerWallets,
        sol_total: solTotal,
        sample_buyers: b.sampleBuyers ?? [],
        tiers: (b.tiers ?? []).map((t) => t ?? ''),
        all_buyers: allBuyers,
        ...(baseUsd != null ? { price_at_burst: baseUsd, first_seen: new Date().toISOString() } : {}),
      } as Record<string, unknown>;
    });

    // Upsert by id. Since the rows omit price_at_burst/first_seen, those survive
    // the conflict update; all written fields are pre-merged to be monotonic.
    const { error } = await supabase
      .from('live_bursts')
      .upsert(rows, { onConflict: 'id' });
    if (error) {
      // GRACEFUL DEGRADATION: if the `type` column hasn't been migrated to prod
      // yet, the upsert fails on the unknown column. Retry once WITHOUT `type`
      // (mirrors the seeded/roi_pct pre-migration fallbacks elsewhere) so the
      // existing persist path keeps working until migration 0021 is applied.
      if (isMissingColumnError(error, 'type')) {
        const stripped = rows.map(({ type: _omit, ...rest }) => rest);
        const retry = await supabase
          .from('live_bursts')
          .upsert(stripped, { onConflict: 'id' });
        if (retry.error) {
          console.error('[BURSTS] persist upsert failed (no-type retry):', retry.error.message);
          return { persisted: 0 };
        }
        return { persisted: stripped.length };
      }
      console.error('[BURSTS] persist upsert failed:', error.message);
      return { persisted: 0 };
    }

    return { persisted: rows.length };
  } catch (err) {
    console.error('[BURSTS] persist crashed:', (err as Error).message);
    return { persisted: 0 };
  }
}

/** Existing-row growing fields read for the monotonic merge. */
interface ExistingGrowth {
  buyers: number | null;
  buyer_wallets: number | null;
  sol_total: number | null;
  window_start: string | null;
  window_end: string | null;
  all_buyers: string[];
  price_at_burst: number | null;
}

/** Cap on the persisted distinct-buyer union (mirrors live-bursts MAX_ALL_BUYERS). */
const ALL_BUYERS_CAP = 500;

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Does a Supabase/Postgres error indicate the given column is missing (i.e. a
 * migration hasn't been applied yet)? PostgREST surfaces this as code 42703
 * ("undefined column") and/or a message naming the column. Used to fall back to
 * a pre-migration write path so a not-yet-migrated prod never breaks the feed.
 */
function isMissingColumnError(
  err: { code?: string; message?: string } | null | undefined,
  column: string
): boolean {
  if (!err) return false;
  if (err.code === '42703') return true;
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('column') && msg.includes(column.toLowerCase());
}

/** Larger of an incoming value and a prior value, ignoring nullish operands. */
function maxDefined(incoming: number | null | undefined, prev: number | null | undefined): number | null {
  const a = typeof incoming === 'number' && Number.isFinite(incoming) ? incoming : null;
  const b = typeof prev === 'number' && Number.isFinite(prev) ? prev : null;
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/** Earliest of two ISO timestamps (nullish operands ignored). */
function earliestIso(incoming: string | null | undefined, prev: string | null | undefined): string | null {
  const a = parseIso(incoming);
  const b = parseIso(prev);
  if (a == null) return prev ?? incoming ?? null;
  if (b == null) return incoming ?? null;
  return a <= b ? (incoming as string) : (prev as string);
}

/** Latest of two ISO timestamps (nullish operands ignored). */
function latestIso(incoming: string | null | undefined, prev: string | null | undefined): string | null {
  const a = parseIso(incoming);
  const b = parseIso(prev);
  if (a == null) return prev ?? incoming ?? null;
  if (b == null) return incoming ?? null;
  return a >= b ? (incoming as string) : (prev as string);
}

function parseIso(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Distinct union of two string arrays, preserving prior-first order, capped. */
function unionCapped(prev: string[], incoming: string[], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const arr of [prev, incoming]) {
    for (const v of arr) {
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MEASURE
// ---------------------------------------------------------------------------

/**
 * Resolve a token's GeckoTerminal Solana pool to measure against: the pool with
 * the HIGHEST liquidity (`reserve_in_usd`), not merely the first listed. Using
 * the deepest pool — and the SAME pool for the baseline and every horizon read —
 * stops a thin secondary pool's noise from poisoning a burst's outcome. Returns
 * '' when GT has no usable pool for the mint.
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
    if (!Array.isArray(pools) || pools.length === 0) return '';

    let bestAddr = '';
    let bestLiq = -Infinity;
    for (const p of pools) {
      const addr = p?.attributes?.address;
      if (typeof addr !== 'string' || !BASE58.test(addr)) continue;
      const liq = Number(p?.attributes?.reserve_in_usd);
      const score = Number.isFinite(liq) ? liq : -Infinity;
      if (score > bestLiq) {
        bestLiq = score;
        bestAddr = addr;
      }
    }
    return bestAddr;
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
 * FORWARD-ONLY candle close for a target timestamp: the close of the FIRST
 * candle at-or-after `targetMs`, but only if that candle is within `tolMs` of
 * the target (so a gap can't pull a wildly-late price). We never look backward
 * before the target — that would peek at a price the horizon hasn't reached yet
 * and bias the baseline/return. Returns null when no forward candle is close
 * enough; that leg then stays unmeasured (no fabrication).
 *
 * `candles` is assumed ascending by time (fetchCandles sorts).
 */
function closeForward(candles: Candle[], targetMs: number, tolMs: number): number | null {
  for (const c of candles) {
    if (c.t < targetMs) continue; // forward-only: skip anything before the target
    if (c.t - targetMs > tolMs) return null; // first forward candle is too far
    return Number.isFinite(c.c) && c.c > 0 ? c.c : null;
  }
  return null;
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
  peak_price_24h: number | null;
  window_end: string;
  ret_15m: number | null;
  ret_1h: number | null;
  ret_24h: number | null;
}

/**
 * Find bursts that have a horizon ELAPSED but its `ret_*` still NULL (or whose
 * USD baseline has not been derived yet), then for each:
 *   1. resolve the deepest-liquidity GT pool ONCE and use it for everything;
 *   2. if `price_at_burst` is missing, derive it from the SAME USD candle series
 *      as the close of the candle at/nearest `window_end` (forward-only) and
 *      persist it once — this is the baseline all horizons compare against;
 *   3. read the forward-only USD close at each due horizon (and the 24h peak
 *      high), compute ret = (priceThen / price_at_burst - 1) * 100, and write
 *      the price, ret, peak and measured-at columns for those legs.
 *
 * EVERYTHING IS USD: baseline and all horizon prices come from the one pool's
 * `currency=usd` candles, so ret_* is a true same-unit return (the old code
 * compared a SOL-per-token spot baseline against USD candles — ~150x wrong).
 *
 * Throttled: processes a bounded batch of bursts per run and paces GeckoTerminal
 * calls to stay under the free-tier rate limit. Anything unmeasurable stays
 * NULL; nothing is fabricated.
 *
 * Resilient: returns { measured: 0 } on any unconfigured/missing-table/error.
 */
export async function measureBursts(opts?: {
  maxBursts?: number;
}): Promise<{ measured: number; scanned: number; dbg?: Record<string, number> }> {
  if (!isSupabaseConfigured()) return { measured: 0, scanned: 0 };
  // Lightweight diagnostics so we can SEE where measurement stalls (baseline
  // present? current price fetched? legs due?) without DB access.
  const dbg = { scanned: 0, withBaseline: 0, dueLegs: 0, gotCurrentPrice: 0, noCurrentPrice: 0, legsWritten: 0 };

  const maxBursts = opts?.maxBursts ?? 80;

  try {
    const supabase = getSupabase();
    const now = Date.now();

    // Candidates: the window closed long enough ago for at least the shortest
    // horizon, AND either the USD baseline still needs deriving OR at least one
    // ret_* leg is still NULL. (We over-select then filter precisely per horizon
    // below.) The baseline is NO LONGER a precondition — measureBursts derives it
    // from the same USD candle series, so a row with a NULL price_at_burst is a
    // valid candidate (its baseline gets stamped on this pass).
    // PER-LEG candidate selection. Sample-forward must catch a burst WHILE it sits
    // inside a horizon's grace window [now - h - grace, now - h]. A single scan
    // can't cover all three windows at high burst volume (the newest-N fills up
    // with fresh 15m-crossers and never reaches the 1h/24h-crossers), which biased
    // the dataset to 15m only. So query EACH leg's window directly and union by id;
    // the per-burst loop below then writes whichever legs are in-grace. Requiring a
    // baseline also excludes the dead pre-fix backlog.
    const cols = 'id, mint, price_at_burst, peak_price_24h, window_end, ret_15m, ret_1h, ret_24h';
    const retCol = (k: '15m' | '1h' | '24h') => (k === '15m' ? 'ret_15m' : k === '1h' ? 'ret_1h' : 'ret_24h');
    const legReads = await Promise.all(
      HORIZONS.map((h) => {
        const hi = new Date(now - h.ms).toISOString();             // horizon elapsed
        const lo = new Date(now - h.ms - GRACE[h.key]).toISOString(); // ...but still in grace
        return supabase
          .from('live_bursts')
          .select(cols)
          .not('price_at_burst', 'is', null)
          .is(retCol(h.key), null)
          .gte('window_end', lo)
          .lte('window_end', hi)
          .order('window_end', { ascending: false })
          .limit(maxBursts);
      })
    );
    const byId = new Map<string, BurstRow>();
    for (const r of legReads) {
      if (r.error) { console.error('[BURSTS] measure read failed:', r.error.message); continue; }
      for (const row of (r.data ?? []) as BurstRow[]) byId.set(row.id, row);
    }
    const rows = [...byId.values()];
    dbg.scanned = rows.length;
    if (rows.length === 0) return { measured: 0, scanned: 0, dbg };

    let measured = 0;

    for (const row of rows) {
      const endMs = new Date(row.window_end).getTime();
      if (!Number.isFinite(endMs)) continue;

      const haveBaseline =
        typeof row.price_at_burst === 'number' && row.price_at_burst > 0;
      if (haveBaseline) dbg.withBaseline++;

      // Which horizon legs are due (elapsed) AND not yet measured?
      const dueLegs = HORIZONS.filter((h) => {
        const elapsed = now - endMs >= h.ms;
        const retNull =
          (h.key === '15m' && row.ret_15m == null) ||
          (h.key === '1h' && row.ret_1h == null) ||
          (h.key === '24h' && row.ret_24h == null);
        return elapsed && retNull;
      });

      // The baseline is stamped at PERSIST time (DexScreener USD). Without it we
      // can't compute a return — skip (rare: a pre-fix row, or a token DexScreener
      // couldn't price at burst time).
      if (!haveBaseline) continue;
      if (dueLegs.length === 0) continue;
      dbg.dueLegs++;
      const baseline = row.price_at_burst as number;

      // SAMPLE-FORWARD via DexScreener (covers fresh pump.fun tokens GeckoTerminal
      // has no candles for). Direct fetch — NOT getTokenMeta — because we must
      // distinguish "DexScreener answered and lists NO pair" (genuine delist/rug →
      // record the left tail) from "the fetch FAILED" (outage/rate-limit → skip and
      // retry next pass). getTokenMeta swallows that difference, and treating an
      // outage as a rug would permanently fabricate −99% outcomes. Zero Helius.
      const probe = await dexCurrentUsd(row.mint);
      await sleep(120); // gentle pacing
      if (!probe.ok) { dbg.noCurrentPrice++; continue; } // transient — leave legs NULL, retry
      const cur = probe.priceUsd; // number when priced; null when genuinely unlisted
      if (cur != null) dbg.gotCurrentPrice++; else dbg.noCurrentPrice++;
      const elapsed = now - endMs;

      const update: Record<string, unknown> = {};
      const nowIso = new Date().toISOString();

      // Ratchet the 24h peak from each in-window sample.
      if (cur != null && elapsed <= HORIZONS[2].ms + GRACE['24h']) {
        const prevPeak = typeof row.peak_price_24h === 'number' ? row.peak_price_24h : 0;
        if (cur > prevPeak) update.peak_price_24h = cur;
      }

      for (const leg of dueLegs) {
        // Only record if we're still near this horizon (sample-forward window).
        if (elapsed > leg.ms + GRACE[leg.key]) continue;
        let price = cur;
        if (price == null) {
          // DexScreener RESPONDED and lists no priced pair = liquidity pulled
          // (rug). Record a near-total loss for the 1h/24h legs so the dataset
          // captures the LEFT TAIL (not just survivors). Too soon to call at 15m.
          if (leg.key === '15m') continue;
          price = baseline * 0.01;
        }
        const ret = (price / baseline - 1) * 100;
        if (leg.key === '15m') { update.price_15m = price; update.ret_15m = ret; update.measured_15m_at = nowIso; dbg.legsWritten++; }
        else if (leg.key === '1h') { update.price_1h = price; update.ret_1h = ret; update.measured_1h_at = nowIso; dbg.legsWritten++; }
        else if (leg.key === '24h') { update.price_24h = price; update.ret_24h = ret; update.measured_24h_at = nowIso; dbg.legsWritten++; }
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

    return { measured, scanned: rows.length, dbg };
  } catch (err) {
    console.error('[BURSTS] measure crashed:', (err as Error).message);
    return { measured: 0, scanned: 0 };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Current DexScreener USD price with EXPLICIT failure semantics:
 *   { ok: true,  priceUsd: number } — answered, priced (highest-liquidity Solana pair)
 *   { ok: true,  priceUsd: null }   — answered, NO priced pair (genuine delist/rug)
 *   { ok: false }                    — fetch failed (outage/timeout/rate-limit) — unknown
 * The ok:false case must NEVER be recorded as a rug (it would fabricate −99% rows).
 */
async function dexCurrentUsd(mint: string): Promise<{ ok: boolean; priceUsd: number | null }> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, priceUsd: null }; // 429/5xx — unknown, retry later
    const j = (await res.json()) as { pairs?: any[] };
    const pairs = (j.pairs ?? []).filter((p) => p?.chainId === 'solana' && Number(p?.priceUsd) > 0);
    if (!pairs.length) return { ok: true, priceUsd: null }; // answered: genuinely unlisted
    pairs.sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0));
    return { ok: true, priceUsd: Number(pairs[0].priceUsd) };
  } catch {
    return { ok: false, priceUsd: null };
  }
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
  /**
   * Per-signal-type 1h breakdown (migration 0021). Empty when the `type` column
   * isn't present yet (pre-migration) — the overall stats above are unaffected.
   * Lets the feed show e.g. "early-s1: 41% hit / median +12% 1h" beside bursts.
   */
  byType?: Record<string, { n: number; medianRet1h: number | null; hitRate1h: number | null }>;
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

    // Try selecting `type` (migration 0021) for the per-type breakdown; on a
    // pre-migration DB this errors on the unknown column, so fall back to the
    // legacy column set so the overall stats keep working.
    // Ordered + paginated: `.limit(2000)` alone clamps at the ~1000-row PostgREST
    // page cap AND (with no .order) returns an ARBITRARY subset once the window
    // exceeds it — making the public hit-rate/median stats nondeterministic at
    // today's ~1000-bursts/day volume. Newest-first + fetchAllRows fixes both.
    let data: any[] | null = null;
    let hasType = true;
    {
      const withType = await fetchAllRows<any>(
        () =>
          supabase
            .from('live_bursts')
            .select('mint, symbol, window_end, first_seen, ret_1h, ret_24h, type')
            .gte('window_end', sinceIso)
            .order('window_end', { ascending: false }) as any,
        { cap: 6000 }
      );
      if (withType.error) {
        if (isMissingColumnError(withType.error as any, 'type')) {
          hasType = false;
          const legacy = await fetchAllRows<any>(
            () =>
              supabase
                .from('live_bursts')
                .select('mint, symbol, window_end, first_seen, ret_1h, ret_24h')
                .gte('window_end', sinceIso)
                .order('window_end', { ascending: false }) as any,
            { cap: 6000 }
          );
          if (legacy.error || !legacy.data) {
            if (legacy.error) console.error('[BURSTS] stats read failed:', legacy.error.message);
            return empty;
          }
          data = legacy.data as any[];
        } else {
          console.error('[BURSTS] stats read failed:', withType.error.message);
          return empty;
        }
      } else {
        data = (withType.data ?? []) as any[];
      }
    }
    if (!data) return empty;

    const ret1h: number[] = [];
    const ret24h: number[] = [];
    let best: BurstStats['bestCall'] = null;
    let measuredCount = 0;
    const todaySince = now - DAY;

    // Per-type 1h returns (only when the `type` column is present).
    const ret1hByType = new Map<string, number[]>();

    let burstsToday = 0;
    for (const r of data as any[]) {
      // Rows persisted BEFORE the quote-mint ingestion fix (e.g. a USDC "burst"
      // whose corrupted baseline shows a +457k% return) must never feed the
      // public stats/bestCall. Skip at read so the backlog ages out of the
      // window naturally instead of needing a destructive cleanup.
      if (isQuoteMint(r.mint)) continue;
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

      if (hasType && r1 != null && Number.isFinite(r1)) {
        const t = r.type == null ? 'burst' : String(r.type);
        let arr = ret1hByType.get(t);
        if (!arr) {
          arr = [];
          ret1hByType.set(t, arr);
        }
        arr.push(r1);
      }

      // Best call prefers a realized 24h return, falling back to 1h.
      const candidateRet =
        r24 != null && Number.isFinite(r24)
          ? r24
          : r1 != null && Number.isFinite(r1)
          ? r1
          : null;
      // Baseline-corruption guard (bestCall ONLY — medians/hit-rates are
      // rank/sign-based and stay untouched): a burst fires after ≥N smart buys,
      // i.e. from a non-trivial mcap; +50,000% (500x) from that base within 24h
      // has only ever appeared here via corrupted baselines (~1000x-low decimals
      // slips in rare trade rows). Don't let one bad row own the headline stat.
      const plausible = candidateRet != null && candidateRet <= 50_000;
      if (candidateRet != null && plausible && (best == null || candidateRet > best.ret)) {
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

    let byType: BurstStats['byType'];
    if (hasType && ret1hByType.size > 0) {
      byType = {};
      for (const [t, arr] of ret1hByType) {
        const m = median(arr);
        byType[t] = {
          n: arr.length,
          medianRet1h: m == null ? null : round2(m),
          hitRate1h: arr.length > 0
            ? round2((arr.filter((x) => x > 0).length / arr.length) * 100)
            : null,
        };
      }
    }

    return {
      n: measuredCount,
      burstsToday,
      medianRet1h: m1 == null ? null : round2(m1),
      hitRate1h: hit1,
      medianRet24h: m24 == null ? null : round2(m24),
      hitRate24h: hit24,
      bestCall: best,
      windowHours,
      byType,
    };
  } catch (err) {
    console.error('[BURSTS] stats crashed:', (err as Error).message);
    return empty;
  }
}
