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
import { getBurstStats } from './burst-outcomes';
import { getTokenMeta } from '../token-meta';
import { fetchTokenPricesSol } from '../prices/price-oracle';
import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { envInt } from './env';

/**
 * MEASURED-TYPE PRIORS for the quality ranking — the outcome engine's per-type
 * hit-rates folded back into selection (audit: outcomes were measured but never
 * used to rank). A type with a PROVEN edge ranks up; a proven loser ranks down;
 * unmeasured/small-n types get 0 (no bias — innocent until measured).
 * Bonus = (hitRate1h − 30) / 20, clamped to ±2, only when n ≥ 20.
 * Cached 10 min module-wide: getBurstStats reads the DB, the feed builds ~every
 * 2s, and priors only move as fast as outcomes accrue. FAIL-OPEN: any error
 * yields an empty map (ranking degrades to the prior-less score, never breaks).
 */
let typePriorCache: { at: number; map: Map<string, number> } | null = null;
const TYPE_PRIOR_TTL_MS = 10 * 60_000;
async function getTypePriors(): Promise<Map<string, number>> {
  if (typePriorCache && Date.now() - typePriorCache.at < TYPE_PRIOR_TTL_MS) return typePriorCache.map;
  const map = new Map<string, number>();
  try {
    const stats = await getBurstStats(72);
    for (const [type, s] of Object.entries(stats.byType ?? {})) {
      if (s.n >= 20 && s.hitRate1h != null && Number.isFinite(s.hitRate1h)) {
        map.set(type, Math.max(-2, Math.min(2, (s.hitRate1h - 30) / 20)));
      }
    }
  } catch {
    // fail-open: empty priors
  }
  typePriorCache = { at: Date.now(), map };
  return map;
}

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
  /**
   * FEED-ONLY: include the "Early" signal layer (early-s1/heating/fresh) in
   * addition to classic bursts. Default false → identical to the prior feed.
   */
  includeEarly?: boolean;
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

/**
 * SHORT freshness window for the live-burst current price/market cap.
 *
 * The displayed CURRENT price/mcap must be the AUTHORITATIVE full-market
 * DexScreener figure (it reflects BUYS *and* SELLS, so a dumping token reads
 * down — unlike the on-chain last-BUY price, which only tracks buys and
 * overstates a token that sold off after the buys). DexScreener's only flaw was
 * its ~120s global cache lagging fast moves. So the live surface force-refreshes
 * any DexScreener entry older than this (~15s) — applied ONLY here (via the
 * getTokenMeta / oracle maxAgeMs overrides), NOT to the global TTL, so the rest
 * of the app's DexScreener load is unchanged.
 *
 * Call-volume: the feed caps visible bursts (~30-50) and DexScreener batches 30
 * mints/call, so a full refresh is ~1-2 calls. Behind the ~2s buildLiveFeed
 * result cache a refresh fires at most once per ~15s per distinct mint set, i.e.
 * ~2 calls / 15s ≈ <10 calls/min from getTokenMeta plus a like amount from the
 * SOL oracle — comfortably within DexScreener's limits.
 */
export const LIVE_PRICE_MAX_AGE_MS = 15_000;

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
    p.includeEarly ? 'early' : '',
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
  const result = await getLiveBursts({
    windowSec,
    minBuyers,
    hours,
    limit: 200,
    includeEarly: p.includeEarly ?? false,
  });

  // Apply caller filters, then rank, then cap to the requested limit.
  let bursts: LiveBurst[] = result.bursts.filter((b) => {
    if (b.solTotal < minSol) return false;
    if (sinceMs != null && new Date(b.windowEnd).getTime() <= sinceMs) return false;
    return true;
  });

  // Quality ranking now folds in the measured-type priors (proven hit-rates per
  // signal type) on top of the buyer-quality/lead-tier upgrades in qualityScore.
  const priors = sort === 'quality' ? await getTypePriors() : undefined;
  bursts.sort((a, b) => {
    if (sort === 'recent') {
      return new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime();
    }
    // quality: composite desc, recency as tiebreak.
    const q = qualityScore(b, priors) - qualityScore(a, priors);
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
    // Skip the per-mint getTokenLargestAccounts RPC here: topHolderPct is a
    // per-card nicety on the FEED hot path, and that extra Helius call bypasses
    // the daily budget. The token DETAIL page still requests it (default on).
    const meta = await getTokenMeta(bursts.map((b) => b.mint), {
      includeTopHolder: false,
      // Demand a ~15s-fresh DexScreener snapshot for the live-burst surface so
      // the displayed price/mcap tracks the real market (buys AND sells) within
      // ~15-20s, instead of the ~120s global cache. Scoped to this enrichment
      // only — the global TTL is untouched (see LIVE_PRICE_MAX_AGE_MS).
      maxAgeMs: LIVE_PRICE_MAX_AGE_MS,
    });
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

  // EARLY LAYER (feed-only): now that pairCreatedAt is enriched, promote a fresh
  // launch and attach the best-effort bundle/sniper flag. No-ops unless the early
  // layer is enabled, so the classic burst feed is byte-identical.
  if (p.includeEarly) {
    bursts = annotateFreshLaunch(bursts);
    bursts = await annotateBundleFlag(bursts);
  }

  // LIVE entry→now price change. The burst card's hero % and the "$entry → $now"
  // market-cap pair must update every poll AND cover fresh pre-graduation
  // pump.fun tokens that DexScreener/GeckoTerminal can't price yet.
  //   - entry price   = firstBuyPriceSol (the burst's first on-chain buy)
  //   - current price = the SHORT-TTL DexScreener oracle (authoritative, reflects
  //     buys AND sells, ~15s fresh) for LISTED tokens; ELSE the burst's most-recent
  //     on-chain TRADE price (any side) for un-listed fresh tokens.
  // This recomputes here on every (cache-missed) feed build, so the % is never
  // frozen at first detection. Fully resilient: the oracle is optional, and any
  // failure simply leaves the on-chain fallback in place.
  bursts = await annotateLivePriceChange(bursts);

  // Annotate each burst with the smart-money EXIT signal via ONE batched,
  // indexed SELL query for the whole (capped) feed. Resilient: on any failure
  // the bursts are returned unchanged (fields stay undefined).
  bursts = await annotateSmartSells(bursts, hours);

  // EXIT-AWARE RE-RANK (quality sort only). netSolFlow/someBuyersExited only
  // exist AFTER enrichment, so the detection-time sort above can't see them: a
  // burst whose own smart buyers are already dumping must not sit at the top of
  // the feed like fresh accumulation (audit: these were computed and DISPLAYED
  // but never ranked on). This re-orders only the visible (capped) page —
  // page membership was decided by the detection-time score, deliberately, so
  // the cheap pass stays cheap.
  if (sort === 'quality') {
    const adj = (b: LiveBurst): number =>
      qualityScore(b, priors) -
      (b.someBuyersExited ? 2 : 0) -
      (typeof b.netSolFlow === 'number' && b.netSolFlow < 0 ? 1.5 : 0);
    bursts.sort((a, b) => {
      const q = adj(b) - adj(a);
      if (q !== 0) return q;
      return new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime();
    });
  }

  // ONE SOL/USD price read per feed build, for client USD conversions (avg ape
  // size). getTokenMeta is batched + ~2min cached, so this is effectively free.
  // Fully resilient: any failure leaves solPriceUsd undefined (never fabricated).
  let solPriceUsd: number | undefined;
  try {
    const solMeta = await getTokenMeta([WSOL_MINT], { includeTopHolder: false });
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
 * Compute a LIVE entry→now price change for each burst and the matching entry
 * market cap, so the card's hero % moves every poll and covers fresh tokens.
 *
 * Current price is resolved per mint with a clear precedence:
 *   1. DexScreener SOL oracle (fetchTokenPricesSol) — the AUTHORITATIVE
 *      full-market price for any LISTED token. It reflects BUYS *and* SELLS, so a
 *      token that smart money bought then dumped reads DOWN, not stuck at its
 *      last-buy peak. Fetched with a SHORT freshness window (LIVE_PRICE_MAX_AGE_MS
 *      ~15s) so it tracks fast moves in BOTH directions without the ~120s global
 *      cache lag — the only flaw the oracle ever had.
 *   2. FALLBACK (un-listed/fresh pump.fun only): the burst's most-recent on-chain
 *      TRADE price (lastTradePriceSol — buy OR sell), so the % still reflects
 *      sells; it falls back to lastBuyPriceSol only when no any-side price exists.
 *      This is the ONLY price available before DexScreener indexes the token.
 * Entry price is always the burst's first on-chain buy (firstBuyPriceSol).
 *
 * WHY the on-chain LAST-BUY is no longer the current price for LISTED tokens:
 * lastBuyPriceSol only advances on BUYS, so for a token that sold off after the
 * smart buys it stays pinned at the peak and OVERSTATES the current mcap (e.g.
 * showing $84.6k when the market is really ~$44k). The full-market DexScreener
 * price is the correct authority; we just make it fresh.
 *
 * entryMarketCapUsd is derived (DexScreener path only) by scaling the current
 * marketCapUsd back through the entry→now price ratio, so the current mcap, the %
 * and the "$entry → $now" pair all share ONE DexScreener basis and can never
 * disagree in direction (the % sign and the mcap arrow / multiplier always agree).
 * For the on-chain fallback entryMarketCapUsd stays null — scaling a DexScreener
 * mcap by an on-chain ratio is exactly the source mismatch we eliminate.
 *
 * FRESHNESS: the displayed current marketCapUsd/priceUsd come from getTokenMeta's
 * DexScreener snapshot, now force-refreshed to ~15s on the live surface (see the
 * computeLiveFeed enrichment) — so it already tracks the real market up AND down;
 * no on-chain rescale of a listed token's mcap is needed or done.
 *
 * FULLY RESILIENT: the oracle call is best-effort (any failure falls back to the
 * on-chain price); bursts without a usable entry price are returned unchanged.
 */
export async function annotateLivePriceChange(bursts: LiveBurst[]): Promise<LiveBurst[]> {
  if (bursts.length === 0) return bursts;

  // One batched SOL-price oracle read for the whole feed, force-refreshed to the
  // short live window (~15s) so a LISTED token's current price is the real
  // full-market price (buys AND sells) and never lags a dump. Best-effort: any
  // failure falls back to the on-chain price below.
  let oracle = new Map<string, number>();
  try {
    oracle = await fetchTokenPricesSol(
      Array.from(new Set(bursts.map((b) => b.mint).filter(Boolean))),
      { maxAgeMs: LIVE_PRICE_MAX_AGE_MS }
    );
  } catch {
    oracle = new Map();
  }

  return bursts.map((b) => {
    const entry =
      b.firstBuyPriceSol != null && Number.isFinite(b.firstBuyPriceSol) && b.firstBuyPriceSol > 0
        ? b.firstBuyPriceSol
        : null;
    if (entry == null) {
      // No on-chain entry price → leave the computed fields null (card falls back
      // to its OHLCV-derived path / "—" exactly as before).
      return { ...b, priceChangeSincePct: null, priceChangeSource: null, entryMarketCapUsd: null };
    }

    // CURRENT PRICE — ONE source per token so the % and the USD mcap pair can't
    // disagree in direction. For a LISTED token the authority is the (fresh)
    // DexScreener oracle, which reflects buys AND sells — so a dumping token reads
    // down. ONLY when DexScreener can't price the token (fresh/un-listed) do we
    // fall back to the on-chain price, preferring the most-recent TRADE of ANY
    // side (lastTradePriceSol) so the fallback also reflects sells, then last-buy.
    const lastTrade =
      b.lastTradePriceSol != null &&
      Number.isFinite(b.lastTradePriceSol) &&
      b.lastTradePriceSol > 0
        ? b.lastTradePriceSol
        : null;
    const lastBuy =
      b.lastBuyPriceSol != null && Number.isFinite(b.lastBuyPriceSol) && b.lastBuyPriceSol > 0
        ? b.lastBuyPriceSol
        : null;
    const onchain = lastTrade ?? lastBuy;

    const oraclePrice = oracle.get(b.mint);
    const listed = oraclePrice != null && Number.isFinite(oraclePrice) && oraclePrice > 0;

    // LISTED → DexScreener oracle is the current price (no on-chain override, the
    // dump-overstatement bug). UN-LISTED → on-chain last-trade fallback.
    const current: number | null = listed ? (oraclePrice as number) : onchain;
    if (current == null) {
      return { ...b, priceChangeSincePct: null, priceChangeSource: null, entryMarketCapUsd: null };
    }

    const pct = Math.round(((current - entry) / entry) * 100 * 100) / 100;
    const source: 'dexscreener' | 'onchain' = listed ? 'dexscreener' : 'onchain';

    // The displayed current mcap/price come from getTokenMeta's now-short-TTL
    // DexScreener snapshot (already ~15s fresh, full-market), so they are left
    // as-is — no on-chain rescale, which is what overstated dumps before.
    const marketCapUsd = b.marketCapUsd;
    const priceUsd = b.priceUsd;

    // Entry market cap is ONLY derived for the DexScreener (listed) path: scale
    // the current mcap back by the entry→now price ratio, so the % and the
    // "$entry → $now" pair share one source and always agree in direction. For the
    // on-chain fallback we leave it null — scaling a DexScreener mcap by an
    // on-chain ratio is exactly the source mismatch we're eliminating, so the card
    // shows the on-chain % WITHOUT a USD pair.
    let entryMarketCapUsd: number | null = null;
    if (
      listed &&
      marketCapUsd != null &&
      Number.isFinite(marketCapUsd) &&
      marketCapUsd > 0 &&
      current > 0
    ) {
      const scaled = (marketCapUsd * entry) / current;
      if (Number.isFinite(scaled) && scaled > 0) {
        entryMarketCapUsd = Math.round(scaled);
      }
    }

    return {
      ...b,
      marketCapUsd,
      priceUsd,
      priceChangeSincePct: pct,
      priceChangeSource: source,
      entryMarketCapUsd,
    };
  });
}

/**
 * FRESH-LAUNCH promotion (Detector #4). Now that pairCreatedAt is enriched, any
 * EARLY signal (or a smart buy that produced no burst) on a token younger than
 * FRESH_MAX_AGE_MIN is re-tagged 'fresh' — the very-young-token signal the user
 * wants surfaced. Pure + synchronous (no queries): it only reads the already-
 * enriched pairCreatedAt. Classic bursts (type 'burst') are NEVER re-tagged, so
 * convergence bursts keep their identity even on a fresh token.
 */
export function annotateFreshLaunch(bursts: LiveBurst[]): LiveBurst[] {
  const maxAgeMs = envInt('FRESH_MAX_AGE_MIN', 10) * 60_000;
  const now = Date.now();
  return bursts.map((b) => {
    if (b.type === 'burst') return b; // never override a real convergence burst
    const createdMs =
      typeof b.pairCreatedAt === 'number' && Number.isFinite(b.pairCreatedAt)
        ? b.pairCreatedAt
        : null;
    if (createdMs == null) return b;
    const ageMs = now - createdMs;
    if (ageMs >= 0 && ageMs < maxAgeMs) return { ...b, type: 'fresh' };
    return b;
  });
}

/**
 * BUNDLE/SNIPER flag (best-effort) — the user's ONE real pump.fun risk.
 *
 * The cheap live-feed enrichment (getTokenMeta: mint/freeze/liq/age) does NOT
 * carry bundle/sniper concentration, and gmgn-cli can't run on Vercel. So this
 * is an ENV-GATED HOOK, OFF by default (BUNDLE_FLAG_ENABLED): when off it is a
 * no-op and every Early card simply renders WITHOUT a bundle chip (bundleFlag
 * stays undefined). It deliberately adds NO per-mint RPC to the hot path.
 *
 * TODO (intended source): GMGN OpenAPI token-security (bundler_rate /
 * sniper_count), already batched + cheap (the GMGN seeder/CLI uses it). Wire the
 * real lookup inside the `enabled` branch below — one batched call over the
 * (capped) feed mints, behind the existing ~2s feed cache — and set bundleFlag /
 * bundleSource:'gmgn' from its result. Until then this returns the feed unchanged
 * so the rest of the Early feature does not depend on it.
 */
export async function annotateBundleFlag(bursts: LiveBurst[]): Promise<LiveBurst[]> {
  const enabled = process.env.BUNDLE_FLAG_ENABLED === '1';
  if (!enabled || bursts.length === 0) return bursts; // default off → no chip
  // Intentionally a stub: NO real bundle source is available at cheap feed time
  // yet (see the TODO above). When GMGN token-security is wired here, replace
  // this with one batched lookup over the capped feed mints and set bundleFlag.
  return bursts;
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
