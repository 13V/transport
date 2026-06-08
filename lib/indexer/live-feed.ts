/**
 * SHARED LIVE-FEED BUILDER + RESULT CACHE
 *
 * The single source of truth for the smart-money LIVE burst feed. Both the
 * polling JSON route (app/api/smart-money/live) and the SSE stream route
 * (app/api/smart-money/live/stream) call buildLiveFeed() so they return the
 * IDENTICAL shape and apply the IDENTICAL filter/sort/cap/enrich logic.
 *
 * Critically, this module adds a short-lived in-process RESULT CACHE keyed by
 * the normalized params (TTL ~2s) with in-flight de-dupe (same pattern as
 * getSmartWalletSet in ./live-bursts). The SSE endpoint holds ONE connection per
 * client and ticks every ~2.5s, and many connections can land on one serverless
 * instance — without this cache each tick (and each concurrent connection) would
 * independently run getLiveBursts + getTokenMeta and hammer the DB. With it,
 * every tick/connection within a ~2s window shares ONE computation, so a single
 * instance issues at most ~1 underlying DB pass per ~2s per distinct param set —
 * the same coalescing the CDN gives the poll route, now for held SSE connections.
 */

import { getLiveBursts, qualityScore, type LiveBurst } from './live-bursts';
import { getTokenMeta } from '../token-meta';
import { getSupabase, isSupabaseConfigured } from '../supabase-client';

/** Inputs to buildLiveFeed — already clamped/parsed by the caller (the routes). */
export interface BuildLiveFeedParams {
  windowSec: number;
  minBuyers: number;
  hours: number;
  limit: number;
  sort: 'quality' | 'recent';
  minSol: number;
  /** `since` cursor in epoch-ms, or null for no lower bound. */
  sinceMs: number | null;
}

/** Output of buildLiveFeed — the exact JSON body shape the poll route returns. */
export interface LiveFeedResult {
  generatedAt: string;
  windowSec: number;
  minBuyers: number;
  count: number;
  nextCursor: string | null;
  bursts: LiveBurst[];
  /** SOL price in USD at build time, for client-side USD conversions (e.g.
   *  average ape size per burst). Undefined when unavailable — never fabricated. */
  solPriceUsd?: number;
}

/** Wrapped-SOL mint, used to read the live SOL/USD price from getTokenMeta. */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** How long a built feed result is reused before recomputation. */
export const RESULT_TTL_MS = 2_000;

interface CacheEntry {
  value: LiveFeedResult;
  at: number;
}

// Per-instance result cache + in-flight map, both keyed by normalized params.
const resultCache = new Map<string, CacheEntry>();
const resultInflight = new Map<string, Promise<LiveFeedResult>>();

/** Stable cache key from the normalized params (order-fixed). */
function cacheKey(p: BuildLiveFeedParams): string {
  return [
    p.windowSec,
    p.minBuyers,
    p.hours,
    p.limit,
    p.sort,
    p.minSol,
    p.sinceMs == null ? '' : p.sinceMs,
  ].join('|');
}

/**
 * Core feed computation (no caching). Mirrors the original route logic exactly:
 * getLiveBursts(limit:200) → filter minSol/since → sort quality|recent → cap to
 * limit → compute nextCursor over the pre-limit filtered set → enrich via
 * getTokenMeta (symbol/name/icon + market + rug fields). Resilient: a metadata
 * failure returns the un-enriched feed.
 */
async function computeLiveFeed(p: BuildLiveFeedParams): Promise<LiveFeedResult> {
  const { windowSec, minBuyers, hours, limit, sort, minSol, sinceMs } = p;

  // Pull more than `limit` so post-filtering (minSol/since) + re-ranking still
  // has a full pool to cap from; the underlying limit is clamped to 200.
  const result = await getLiveBursts({ windowSec, minBuyers, hours, limit: 200 });

  // Apply caller filters, then rank, then cap to the requested limit.
  let bursts: LiveBurst[] = result.bursts.filter((b) => {
    if (b.solTotal < minSol) return false;
    if (sinceMs != null && new Date(b.windowEnd).getTime() <= sinceMs) return false;
    return true;
  });

  bursts.sort((a, b) => {
    if (sort === 'recent') {
      return new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime();
    }
    // quality: composite desc, recency as tiebreak.
    const q = qualityScore(b) - qualityScore(a);
    if (q !== 0) return q;
    return new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime();
  });

  bursts = bursts.slice(0, limit);

  // Cursor for bot polling: the newest windowEnd across the (pre-limit) filtered
  // set, so a follower can pass it back as ?since= and only get newer bursts.
  let nextCursor: string | null = null;
  for (const b of result.bursts) {
    if (b.solTotal < minSol) continue;
    if (!nextCursor || new Date(b.windowEnd).getTime() > new Date(nextCursor).getTime()) {
      nextCursor = b.windowEnd;
    }
  }

  // Enrich bursts with real symbol/name/icon + live market stats from
  // DexScreener/Helius. A metadata failure must never break the feed, so
  // getTokenMeta is resilient and we additionally guard here.
  try {
    const meta = await getTokenMeta(bursts.map((b) => b.mint));
    bursts = bursts.map((b) => {
      const m = meta.get(b.mint);
      if (!m) return b;
      // Read newer TokenMeta fields loosely: another agent is adding these to
      // TokenMeta in parallel, so access them off a loose alias with optional
      // chaining. Safe (undefined) even before the fields land on the type.
      const mx = m as Record<string, unknown>;
      return {
        ...b,
        symbol: m.symbol,
        name: m.name,
        icon: m.icon,
        icons: m.icons,
        marketCapUsd: m.marketCapUsd,
        liquidityUsd: m.liquidityUsd,
        priceChange24h: m.priceChange24h,
        priceUsd: m.priceUsd,
        pairAddress: m.pairAddress,
        mintRenounced: mx?.mintRenounced as boolean | undefined,
        freezeRenounced: mx?.freezeRenounced as boolean | undefined,
        pairCreatedAt: mx?.pairCreatedAt as number | undefined,
        buys24h: mx?.buys24h as number | undefined,
        sells24h: mx?.sells24h as number | undefined,
        volume24hUsd: mx?.volume24hUsd as number | undefined,
        topHolderPct: mx?.topHolderPct as number | undefined,
      };
    });
  } catch {
    // ignore — return the un-enriched feed
  }

  // Annotate each burst with the smart-money EXIT signal via ONE batched,
  // indexed SELL query for the whole (capped) feed. Resilient: on any failure
  // the bursts are returned unchanged (fields stay undefined).
  bursts = await annotateSmartSells(bursts, hours);

  // ONE SOL/USD price read per feed build, for client USD conversions (avg ape
  // size). getTokenMeta is batched + ~2min cached, so this is effectively free.
  // Fully resilient: any failure leaves solPriceUsd undefined (never fabricated).
  let solPriceUsd: number | undefined;
  try {
    const solMeta = await getTokenMeta([WSOL_MINT]);
    const price = solMeta.get(WSOL_MINT)?.priceUsd;
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      solPriceUsd = price;
    }
  } catch {
    // ignore — leave solPriceUsd undefined
  }

  return { ...result, count: bursts.length, nextCursor, bursts, solPriceUsd };
}

/**
 * Annotate bursts with whether smart wallets are already SELLING the token.
 *
 * Runs exactly ONE batched query for the WHOLE feed (not per card): SELL trades
 * over the same `hours` lookback, scoped to the (small, capped) set of burst
 * mints AND to the exact buyer wallets we already know are in those bursts. That
 * wallet set is small and exact, so we don't need the full smart-wallet `.in()`
 * list, and the query rides the trades(token_mint, block_time) index. It runs
 * once per feed build, behind the 2s buildLiveFeed result cache.
 *
 * Cost: 1 query/feed build (cached 2s). No per-card queries, no extra latency on
 * the hot path beyond this single batched read.
 *
 * FULLY RESILIENT: not configured, no mints, or a query error -> bursts returned
 * unchanged with the new fields left undefined.
 */
async function annotateSmartSells(
  bursts: LiveBurst[],
  hours: number
): Promise<LiveBurst[]> {
  if (bursts.length === 0 || !isSupabaseConfigured()) return bursts;

  // Collect the distinct burst mints and the exact buyer wallets we already
  // know are "in" (the smart wallets that produced these bursts). Filtering
  // sells to these wallets keeps the .in() list small and exact.
  const burstMints = Array.from(new Set(bursts.map((b) => b.mint).filter(Boolean)));
  const buyerWalletSet = new Set<string>();
  for (const b of bursts) {
    for (const w of b.wallets) if (w) buyerWalletSet.add(w);
  }
  if (burstMints.length === 0 || buyerWalletSet.size === 0) return bursts;
  const buyerWallets = Array.from(buyerWalletSet);

  try {
    const supabase = getSupabase();
    const sinceIso = new Date(Date.now() - hours * 3_600_000).toISOString();

    // ONE batched, indexed query for the whole feed.
    const { data, error } = await supabase
      .from('trades')
      .select('wallet, token_mint, amount, price, block_time')
      .eq('trade_type', 'SELL')
      .in('token_mint', burstMints)
      .in('wallet', buyerWallets)
      .gte('block_time', sinceIso);

    if (error || !data) return bursts;

    // Aggregate sells per mint: distinct seller wallets + total SOL value.
    interface SellAgg {
      sellers: Set<string>;
      sol: number;
    }
    const byMint = new Map<string, SellAgg>();
    for (const row of data as any[]) {
      const mint = String(row.token_mint);
      const wallet = String(row.wallet);
      if (!mint || !wallet) continue;
      const amount = Number(row.amount);
      const price = Number(row.price);
      const sol =
        Number.isFinite(amount) && Number.isFinite(price) ? amount * price : 0;
      let agg = byMint.get(mint);
      if (!agg) {
        agg = { sellers: new Set(), sol: 0 };
        byMint.set(mint, agg);
      }
      agg.sellers.add(wallet);
      agg.sol += sol;
    }

    return bursts.map((b) => {
      const agg = byMint.get(b.mint);
      if (!agg) {
        // No smart-money sells for this token in-window: explicitly net-zero exit.
        return {
          ...b,
          smartSellWallets: 0,
          smartSellSol: 0,
          netSolFlow: Math.round(b.solTotal * 1e4) / 1e4,
          someBuyersExited: false,
        };
      }
      const smartSellSol = Math.round(agg.sol * 1e4) / 1e4;
      // Did any wallet in THIS burst's buyer set also sell this same token?
      const buyerSet = new Set(b.wallets);
      let someBuyersExited = false;
      for (const seller of agg.sellers) {
        if (buyerSet.has(seller)) {
          someBuyersExited = true;
          break;
        }
      }
      return {
        ...b,
        smartSellWallets: agg.sellers.size,
        smartSellSol,
        netSolFlow: Math.round((b.solTotal - smartSellSol) * 1e4) / 1e4,
        someBuyersExited,
      };
    });
  } catch {
    // Never break the feed on the exit-signal query.
    return bursts;
  }
}

/**
 * Build the live feed for the given (already-clamped) params, served from a
 * ~2s in-process result cache with in-flight de-dupe. Concurrent callers within
 * the window share ONE computation, bounding DB load under SSE fan-out.
 */
export async function buildLiveFeed(p: BuildLiveFeedParams): Promise<LiveFeedResult> {
  const key = cacheKey(p);
  const now = Date.now();

  const hit = resultCache.get(key);
  if (hit && now - hit.at < RESULT_TTL_MS) return hit.value;

  const inflight = resultInflight.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<LiveFeedResult> => {
    try {
      const value = await computeLiveFeed(p);
      resultCache.set(key, { value, at: Date.now() });
      return value;
    } finally {
      resultInflight.delete(key);
    }
  })();

  resultInflight.set(key, promise);
  return promise;
}
