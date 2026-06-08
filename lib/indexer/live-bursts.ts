/**
 * SMART-MONEY LIVE BUY BURSTS
 *
 * Detects "buy bursts" — moments where ≥N distinct smart-money ENTITIES bought
 * the SAME token inside a short window (default 30s). Several independently
 * curated wallets all hitting one token within seconds of each other is a far
 * sharper, more time-sensitive signal than the slower "buying" aggregate: it's
 * the live "smart money just piled into X" moment.
 *
 * Pipeline (mirrors lib/indexer/smart-buys.ts — its hard parts are reused):
 *   1. Resolve the smart-wallet set (verified wallets that clear the curation
 *      gate) + a wallet→entity (funding-cluster) map so wallets controlled by
 *      one trader collapse to a single entity, plus a wallet→score map for tiers.
 *   2. Pull their recent BUY trades over the last `hours`.
 *   3. Per token, sort buys ascending by time and group them into ACCUMULATION
 *      STREAKS: consecutive buys whose gap to the previous buy is ≤ `windowSec`
 *      belong to the same streak (momentum is still going). A streak with
 *      ≥ `minBuyers` DISTINCT ENTITIES becomes a single burst whose SOL total and
 *      buyer count KEEP GROWING as more smart money buys — sustained
 *      accumulation is ONE growing burst, not many fragmented fixed windows.
 *
 * Degrades gracefully: any failure (Supabase unconfigured, missing columns,
 * cluster resolution error) returns an empty burst list instead of throwing.
 */

import { createHash } from 'crypto';
import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getBroadSmartCriteria, isSmartWallet } from './curation';
import { buildClusters } from './clusters';
import { tierFromScore } from '../format';
import { readSnapshot, writeSnapshot } from './smart-set-cache';
import { envInt } from './env';
import { fetchAllRows } from '../db-paginate';

export interface LiveBurst {
  /**
   * Stable content hash of (mint, side, windowStartMs) where windowStartMs is
   * the streak's FIRST buy. IDENTITY IS THE REAL STREAK ONLY — threshold params
   * (minBuyers, windowSec) are deliberately NOT hashed in, so the SAME real
   * accumulation streak gets the SAME id regardless of the caller's threshold
   * (feed minBuyers=3, buy-alert=4, persist=3 all agree). The threshold is a
   * FILTER (see flush), not part of identity. Stays constant as the streak keeps
   * accumulating later buys, so clients/persist/alerts dedupe + cross-reference
   * reliably.
   */
  id: string;
  mint: string;
  /** Distinct smart-money ENTITIES (cluster-deduped) over the whole streak. */
  buyers: number;
  /** Raw distinct buyer WALLET addresses over the streak (pre-cluster-dedup). */
  buyerWallets: number;
  /** Cumulative sum of amount*price (SOL value) over the whole streak. */
  solTotal: number;
  /** ISO timestamp of the FIRST buy in the accumulation streak. */
  windowStart: string;
  /** ISO timestamp of the LATEST buy in the accumulation streak. */
  windowEnd: string;
  /** Up to 5 distinct buyer wallet addresses from the streak. */
  sampleBuyers: string[];
  /**
   * FULL distinct buyer/seller wallet address set over the streak (pre-cluster).
   * Used for per-user watchlist matching; `sampleBuyers` stays the 5-cap UI set.
   */
  wallets: string[];
  /**
   * DISTINCT buyer wallet addresses over the whole streak (pre-cluster-dedup),
   * capped at MAX_ALL_BUYERS. Persisted to live_bursts.all_buyers and used for
   * per-wallet attribution (track records, backtester). Most bursts are well
   * under the cap; `wallets` is the uncapped in-memory set for watchlist matching.
   */
  allBuyers?: string[];
  /** Which side of the trade this burst represents. Defaults to 'buy'. */
  side: 'buy' | 'sell';
  /**
   * Tier string (S/A/B/C) or null per buyer, ALIGNED to `sampleBuyers` order.
   * Derived from each wallet's composite score via tierFromScore.
   */
  tiers: (string | null)[];
  /**
   * Per-buyer conviction stats ALIGNED to `sampleBuyers` order. Tier is derived
   * from the wallet's score (tierFromScore); roiPct/winRate are the wallet's
   * verified historical stats. null fields mean the stat wasn't available.
   */
  buyerStats?: { addr: string; tier: string | null; roiPct: number | null; winRate: number | null }[];
  /**
   * SMART INHERITANCE display fields (optional; absent when the SmartSet has no
   * fundedByWallet map, e.g. an older snapshot — render nothing then).
   *  - inheritedBuyers: how many DISTINCT inherited (funded-fresh) wallets are in
   *    this streak. >0 means the burst includes at least one new wallet that is
   *    smart only because a proven smart wallet funded it.
   *  - sampleFunded: per-sampleBuyers entry, ALIGNED to sampleBuyers order. When
   *    a sample buyer is inherited, carries its funder's short address; otherwise
   *    null. Lets the UI badge exactly the rows that are inherited.
   */
  inheritedBuyers?: number;
  sampleFunded?: (string | null)[];
  /** Wallet of the FIRST (earliest) trade in the accumulation streak. */
  leadBuyer?: string;
  /** Tier of the lead buyer's wallet (tierFromScore), or null. */
  leadTier?: string | null;
  /**
   * Total distinct smart ENTITIES across the whole smart-wallet set, so clients
   * can show coverage ("% of smart set in"). Counts entities by mapping every
   * smart wallet through the wallet→entity map (wallets with no cluster are
   * their own entity); this is the entity-deduped denominator.
   */
  smartSetSize?: number;
  /**
   * Transparent, conviction-scaled size SUGGESTION in SOL (NOT financial advice).
   * Formula: tierWeight = sum over sampleBuyers of (S=3, A=2, B=1, else 0.5);
   * raw = 0.15 * tierWeight * log1p(solTotal); then CLAMP to [0.1, 5] and round
   * to 2 decimals. Deliberately modest — scales with both buyer quality and the
   * streak's SOL size, but capped so it never reads as a large recommendation.
   */
  suggestedSizeSol?: number;
  /**
   * True once the streak can no longer absorb new buys (windowEnd is older than
   * windowSec before now), i.e. accumulation has settled. False while the streak
   * is still accumulating (more buys can extend it).
   */
  finalized: boolean;
  // Enrichment fields (left undefined here; the route fills these in).
  symbol?: string;
  name?: string;
  icon?: string;
  icons?: string[];
  // Live market enrichment (from the highest-liquidity DexScreener pair).
  marketCapUsd?: number;
  liquidityUsd?: number;
  priceChange24h?: number;
  priceUsd?: number;
  pairAddress?: string;
  /**
   * On-chain trade price (SOL per token) at the streak's FIRST buy, straight
   * from the trades the burst is built on. The honest "entry" price even when
   * DexScreener has no pair yet (fresh pump.fun token). null when no priced row.
   */
  firstBuyPriceSol?: number | null;
  /**
   * On-chain trade price (SOL per token) at the streak's MOST RECENT buy. Used
   * as a live current-price FALLBACK when DexScreener/GeckoTerminal can't price
   * the token, so the entry→now % still moves as fresh tokens run. null when no
   * priced row.
   */
  lastBuyPriceSol?: number | null;
  /**
   * Server-computed % price change from the burst's entry (firstBuyPriceSol) to
   * the live current price. Current price prefers the DexScreener oracle and
   * FALLS BACK to the most-recent on-chain trade price (lastBuyPriceSol) so it
   * is populated even for fresh pump.fun tokens DexScreener hasn't listed.
   * Recomputed every feed build (behind the ~2s cache), so it moves each poll.
   * null when no entry price is known. Filled by computeLiveFeed, not here.
   */
  priceChangeSincePct?: number | null;
  /**
   * Which source drove priceChangeSincePct (and therefore entryMarketCapUsd):
   *  - 'dexscreener': the live DexScreener oracle priced the token, so BOTH the %
   *    and the entry→now USD mcap pair come from one source and agree in
   *    direction/magnitude. The card may render the "$entry → $now" pair.
   *  - 'onchain': DexScreener has no current price (un-listed/fresh token); the %
   *    is from the on-chain firstBuy→lastBuy prices and there is NO trustworthy
   *    USD mcap (entryMarketCapUsd stays null) — the card shows the % WITHOUT a
   *    fabricated/source-mismatched USD pair.
   * null when no % could be computed. CONSISTENCY GUARANTEE: the % sign and any
   * USD mcap arrow shown always agree because they share this single source.
   */
  priceChangeSource?: 'dexscreener' | 'onchain' | null;
  /**
   * Server-computed entry (first-buy) market cap in USD, derived by scaling the
   * current marketCapUsd back by the entry→now price ratio. ONLY populated when
   * priceChangeSource is 'dexscreener' (so the % and the USD pair come from the
   * SAME source and can't disagree in direction). null for the on-chain fallback
   * — we never scale a DexScreener mcap by an on-chain ratio (that mismatch was
   * the "$55k → $24k but +0.0%" bug). Filled by computeLiveFeed.
   */
  entryMarketCapUsd?: number | null;
  // Additional TokenMeta enrichment (filled by the route; safe-optional in case
  // a field isn't yet present on TokenMeta).
  mintRenounced?: boolean;
  freezeRenounced?: boolean;
  pairCreatedAt?: number;
  buys24h?: number;
  sells24h?: number;
  volume24hUsd?: number;
  topHolderPct?: number;
  // Smart-money EXIT signal (filled in computeLiveFeed via ONE batched, indexed
  // SELL query per feed build). All optional + backward-compatible: if the sell
  // query fails or returns nothing, these stay undefined and the feed is
  // unchanged. Answers "is smart money already selling this token?"
  /** Distinct smart wallets that SOLD this token in the lookback window. */
  smartSellWallets?: number;
  /** Total SOL value (amount*price) of those smart-money sells. */
  smartSellSol?: number;
  /** solTotal (buys) - smartSellSol. Positive = net accumulating; negative = net distributing. */
  netSolFlow?: number;
  /** True if any wallet in this burst's buyer set also appears in the sells (they're flipping out). */
  someBuyersExited?: boolean;
}

export interface LiveBurstsResult {
  generatedAt: string;
  windowSec: number;
  minBuyers: number;
  count: number;
  bursts: LiveBurst[];
}

/**
 * Resolved smart-money set shared by the live feed and the real-time alert
 * webhook. Memoized in-process (see getSmartWalletSet) because it only changes
 * on the indexer's cron cadence, not per request.
 */
export interface SmartSet {
  wallets: Set<string>;
  walletToEntity: Map<string, string>;
  scoreByWallet: Map<string, number>;
  /**
   * Per-wallet verified conviction stats (the same rows already read for the
   * curation gate, just retained). Used to surface buyer ROI/win-rate on bursts.
   */
  statsByWallet: Map<string, { score: number; roiPct: number | null; winRate: number | null; realizedPnl: number }>;
  /**
   * SMART INHERITANCE map: inherited (fresh) wallet -> the verified smart wallet
   * that funded it. ONLY wallets pulled in by addFundedFreshWallets appear here;
   * verified wallets (in the set on their own record) are deliberately absent.
   * Lets the UI explain WHY a no-history wallet is flagged smart ("new wallet
   * funded by a tracked smart wallet — likely the same trader"). Optional: an
   * older snapshot rebuilt without it simply yields no inheritance badges.
   */
  fundedByWallet?: Map<string, string>;
  /**
   * FAIL-CLOSED flag (signal H2): true when the wallet_links cluster resolution
   * ERRORED, so the wallet→entity map could NOT be trusted to collapse one
   * actor's split wallets into a single entity. When set, burst detection must
   * NOT emit bursts whose entity count was derived from raw wallets (that would
   * let one actor's split wallets trivially meet minBuyers). We prefer
   * under-reporting conviction to over-reporting it. An EMPTY map with this flag
   * FALSY is the legitimate "no clusters exist" case (every wallet is genuinely
   * its own entity) and is fully trusted. Optional: absent/false both mean
   * VERIFIED — the persisted snapshot is only ever written from a clean resolve,
   * so a snapshot-rebuilt set (which omits the flag) is correctly trusted.
   */
  entitiesUnverified?: boolean;
}

const WALLET_CHUNK = 200; // Supabase .in() list size per query
const MAX_TRADE_ROWS = 3000; // hard cap on rows pulled across all chunks

// Tier weights for the "quality" composite ranking.
const TIER_WEIGHT: Record<string, number> = { S: 3, A: 2, B: 1, C: 0.5 };

// Cap on the distinct buyer wallet list retained for per-wallet attribution
// (live_bursts.all_buyers). Most bursts hold far fewer; this bounds the array.
const MAX_ALL_BUYERS = 60;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Count distinct smart ENTITIES across the whole smart-wallet set: every wallet
 * is mapped through the wallet→entity map; a wallet with no cluster is its own
 * entity. This is the entity-deduped denominator clients use for "% of smart set
 * in" coverage.
 */
function countSmartEntities(
  wallets: Set<string>,
  walletToEntity: Map<string, string>
): number {
  const entities = new Set<string>();
  for (const w of wallets) entities.add(walletToEntity.get(w) ?? w);
  return entities.size;
}

/**
 * Stable id: short content hash of (mint, side, windowStartMs) ONLY so the id
 * doesn't drift as the window grows AND so the same real streak resolves to the
 * same id across every caller regardless of their threshold (minBuyers /
 * windowSec are FILTERS, not identity). This keeps the live feed, the webhook
 * alerts, and the persisted live_bursts row (posted_call/posted_result, measured
 * outcomes) all keyed on the same id for one streak.
 */
function burstId(
  mint: string,
  side: 'buy' | 'sell',
  windowStartMs: number
): string {
  const h = createHash('sha1')
    .update(`${mint}|${side}|${windowStartMs}`)
    .digest('hex');
  return h.slice(0, 16);
}

/**
 * Build a wallet -> entity-id map where wallets in the same funding cluster
 * share an entity id (the cluster's stable representative member). Mirrors the
 * approach in smart-buys.ts: fetch the wallet_links edges touching the smart
 * set in a few batched .in() queries, then run the pure in-memory union-find
 * from clusters.ts.
 *
 * FAILS CLOSED (signal H2): if the wallet_links query ERRORS (or throws) we
 * CANNOT trust that one actor's split wallets collapse to a single entity, so we
 * return { error: true }. The caller then flags bursts as unverified-entities
 * rather than counting raw wallets as separate entities (which would let one
 * actor trivially meet minBuyers with split wallets). A clean read with zero
 * edges returns { map: empty, error: false } — the legitimate "no clusters"
 * case where every wallet genuinely is its own entity.
 */
async function resolveEntityMap(
  wallets: string[]
): Promise<{ map: Map<string, string>; error: boolean }> {
  const entityMap = new Map<string, string>();
  if (wallets.length === 0 || !isSupabaseConfigured()) {
    return { map: entityMap, error: false };
  }

  try {
    const supabase = getSupabase();
    const edges: { source: string; target: string }[] = [];

    for (const group of chunk(wallets, WALLET_CHUNK)) {
      for (const col of ['source', 'target'] as const) {
        const { data, error } = await supabase
          .from('wallet_links')
          .select('source, target')
          .in(col, group);
        if (error) return { map: new Map(), error: true }; // FAIL CLOSED
        for (const row of data ?? []) {
          const src = (row as any).source as string;
          const tgt = (row as any).target as string;
          if (src && tgt) edges.push({ source: src, target: tgt });
        }
      }
    }

    if (edges.length === 0) return { map: entityMap, error: false };

    const clusters = buildClusters(edges);
    for (const [wallet, members] of clusters) {
      entityMap.set(wallet, members[0] ?? wallet);
    }
    return { map: entityMap, error: false };
  } catch {
    return { map: new Map(), error: true }; // FAIL CLOSED on any cluster error
  }
}

/**
 * Resolve the smart-wallet set + entity map + per-wallet score, cached in two
 * layers (see getSmartWalletSet): a per-instance in-process memo (~5 min) backed
 * by a persisted snapshot in indexer_state (~5 min). The underlying data
 * (verified wallet stats + funding clusters) only changes on cron cadence, so
 * /live and the alert webhook share one resolution instead of each re-running
 * the heavy paginate+cluster resolve (~25 DB queries) per cold instance.
 *
 * Raised from 60s to 5 min: the smart set moves slowly, and the persisted
 * snapshot already bounds how often the heavy resolve runs globally, so a longer
 * in-process memo is safe and further cuts DB load.
 */
const SMART_SET_TTL_MS = 5 * 60 * 1000;
let smartSetCache: { value: SmartSet; at: number } | null = null;
let smartSetInflight: Promise<SmartSet> | null = null;

/**
 * SMART INHERITANCE — follow the trader, not the wallet.
 *
 * Top traders rotate to fresh wallets to shake trackers. run-link-tracking
 * already detects when a PROVEN wallet funds a fresh address (meaningful SOL,
 * not CEX/system — see wallet-links.ts) and stamps the recipient's
 * wallet_stats.funded_by. But a fresh wallet has no track record, so the
 * curation gate never lets it in — and its first buys (the whole edge) go
 * unsurfaced. This pulls those fresh wallets into the smart set: a wallet
 * funded by a smart wallet is almost always the same operator, so we treat it
 * as smart IMMEDIATELY — its buys count, and (via sync-webhook) Helius starts
 * streaming its trades the moment it's detected.
 *
 * Guardrails: only UNVERIFIED recipients inherit (a verified wallet stands on
 * its own record — real evidence wins over a funding hop); one hop only (funder
 * must be in the verified-smart set, not itself inherited); per-funder + global
 * caps stop a disperser from flooding the set; inherited stats are NULL (no
 * fabricated history) and the score is the funder's, lightly discounted so a
 * proven wallet always outranks its inherited cousins. Disable with
 * SMART_INHERIT_FUNDED=0.
 */
async function addFundedFreshWallets(
  supabase: ReturnType<typeof getSupabase>,
  wallets: Set<string>,
  scoreByWallet: Map<string, number>,
  statsByWallet: Map<
    string,
    { score: number; roiPct: number | null; winRate: number | null; realizedPnl: number }
  >,
  fundedByWallet: Map<string, string>
): Promise<void> {
  if (process.env.SMART_INHERIT_FUNDED === '0') return;

  const perFunderCap = envInt('SMART_INHERIT_PER_FUNDER', 25);
  const totalCap = envInt('SMART_INHERIT_MAX', 1500);
  const SCORE_FACTOR = 0.9; // inherited conviction sits just below the funder's

  // One-hop only: funders are the verified-smart wallets resolved so far.
  const funders = Array.from(wallets);
  const perFunder = new Map<string, number>();
  let added = 0;

  for (const batch of chunk(funders, 200)) {
    if (added >= totalCap) break;
    // Fresh (unverified) wallets funded by a smart wallet. Most-active first so
    // that under a cap we keep the fresh wallets already trading.
    const { data, error } = await supabase
      .from('wallet_stats')
      .select('wallet, funded_by, total_trades')
      .in('funded_by', batch)
      .eq('verified', false)
      .order('total_trades', { ascending: false })
      .limit(2000);
    if (error || !data) continue; // tolerate pre-funded_by DB / query error

    for (const r of data as any[]) {
      if (added >= totalCap) break;
      const wallet = String(r.wallet);
      const funder = String(r.funded_by);
      if (!wallet || wallets.has(wallet)) continue; // already smart on own merit
      const n = perFunder.get(funder) ?? 0;
      if (n >= perFunderCap) continue;

      perFunder.set(funder, n + 1);
      wallets.add(wallet);
      // Record WHY this fresh wallet is smart: it was funded by `funder` (a
      // verified smart wallet). Only inherited wallets enter this map.
      fundedByWallet.set(wallet, funder);
      added++;
      const inheritedScore = (scoreByWallet.get(funder) ?? 0) * SCORE_FACTOR;
      if (inheritedScore > 0) scoreByWallet.set(wallet, inheritedScore);
      // NULL stats = honest "no own track record yet" (fresh wallet); the UI
      // shows it as smart-by-association rather than a fabricated history.
      statsByWallet.set(wallet, {
        score: inheritedScore,
        roiPct: null,
        winRate: null,
        realizedPnl: 0,
      });
    }
  }
}

async function resolveSmartSet(): Promise<SmartSet> {
  const empty: SmartSet = {
    wallets: new Set(),
    walletToEntity: new Map(),
    scoreByWallet: new Map(),
    statsByWallet: new Map(),
    fundedByWallet: new Map(),
    entitiesUnverified: false,
  };
  if (!isSupabaseConfigured()) return empty;

  try {
    const supabase = getSupabase();
    // INCLUSION uses the BROAD gate so more potential burst participants (and the
    // Helius-synced webhook set, which is derived from this same set) are covered.
    const criteria = getBroadSmartCriteria();
    const now = Date.now();

    // Only verified (deep-scanned) wallets have trustworthy stats; apply the
    // full curation gate in JS. `score` is selected so we can attach tiers.
    // profit_factor (migration 0013) and consistency (base schema) MUST be
    // selected so the gate's edge floors (SMART_MIN_PROFIT_FACTOR /
    // SMART_MIN_CONSISTENCY) evaluate against real values — without them every
    // wallet's profitFactor/consistency read as null and, the moment an operator
    // enables either floor, the whole live/alert smart set collapses to empty.
    // realized_events is NOT a real column, so it's omitted and realizedEvents is
    // passed as null — the suspect-win-rate rule then falls back to totalTrades.
    const statCols =
      'wallet, score, realized_pnl, roi_pct, invested_sol, win_rate, total_trades, tokens_traded, last_trade_at, seeded, profit_factor, consistency';
    // PUSH THE CHEAP GATE INTO SQL FIRST (mirrors app/api/status/route.ts's
    // buildGate). The OLD query fetched the top-SMART_SET_MAX verified rows BY
    // SCORE and only filtered to smart in JS — so once the verified set exceeds
    // the cap, genuine (mostly lower-ROI A-tier) smart wallets ranked below the
    // cap were dropped before they were ever tested, starving the feed/alerts of
    // ~hundreds of real smart wallets. By applying the gate's cheap numeric
    // floors in SQL the prefiltered set is ~the smart total (~2k), so the cap
    // (which still backstops pagination) rarely binds. The JS isSmartWallet
    // confirm below still applies the bot/suspect/maxWinRate nuance not
    // expressible in SQL, so the final set is byte-identical to the gate.
    const buildGate = () => {
      let qb = supabase
        .from('wallet_stats')
        .select(statCols)
        .eq('verified', true)
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
    let statRead = await fetchAllRows(buildGate, { cap: envInt('SMART_SET_MAX', 5000) });

    // DEGRADED / pre-migration fallback (as /api/status does): if the roi_pct /
    // invested_sol columns (or the gate filters) aren't available, fall back to
    // the original top-N-by-score + JS-only filtering so the feed keeps working.
    if (statRead.error) {
      statRead = await fetchAllRows(
        () =>
          supabase
            .from('wallet_stats')
            .select(statCols)
            .eq('verified', true)
            .order('score', { ascending: false }),
        { cap: envInt('SMART_SET_MAX', 5000) }
      );
    }

    if (statRead.error || !statRead.data) return empty;

    const wallets = new Set<string>();
    const scoreByWallet = new Map<string, number>();
    const statsByWallet = new Map<
      string,
      { score: number; roiPct: number | null; winRate: number | null; realizedPnl: number }
    >();
    for (const r of statRead.data as any[]) {
      const realizedPnl = Number(r.realized_pnl);
      const roiPct = r.roi_pct == null ? null : Number(r.roi_pct);
      const winRate = Number(r.win_rate);
      const ok = isSmartWallet(
        {
          realizedPnl,
          roiPct,
          investedSol: r.invested_sol == null ? null : Number(r.invested_sol),
          winRate,
          // Edge floors read these; map null DB values to null so a disabled
          // floor (0) lets them pass and an enabled floor rejects only unscored
          // wallets — instead of silently nulling EVERY wallet (set collapse).
          profitFactor: r.profit_factor == null ? null : Number(r.profit_factor),
          consistency: r.consistency == null ? null : Number(r.consistency),
          // No realized_events column; pass null so the suspect-win-rate rule
          // falls back to totalTrades (as it already does for unknown samples).
          realizedEvents: null,
          totalTrades: Number(r.total_trades),
          tokensTraded: Number(r.tokens_traded),
          lastTradeAt: r.last_trade_at,
          seeded: Boolean(r.seeded),
        },
        criteria,
        now
      );
      if (!ok) continue;
      const wallet = String(r.wallet);
      wallets.add(wallet);
      const score = Number(r.score);
      if (Number.isFinite(score)) scoreByWallet.set(wallet, score);
      // Retain the verified stats already read above for buyer conviction display.
      statsByWallet.set(wallet, {
        score: Number.isFinite(score) ? score : 0,
        roiPct: roiPct != null && Number.isFinite(roiPct) ? roiPct : null,
        winRate: Number.isFinite(winRate) ? winRate : null,
        realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : 0,
      });
    }

    if (wallets.size === 0) return empty;

    // Pull in fresh wallets funded by these smart wallets (same operator on a
    // new wallet). Done BEFORE clustering so resolveEntityMap groups each fresh
    // wallet into its funder's entity — preserving anti-sybil burst counts (a
    // funder + its fresh wallets = ONE entity).
    const fundedByWallet = new Map<string, string>();
    await addFundedFreshWallets(supabase, wallets, scoreByWallet, statsByWallet, fundedByWallet);

    const { map: walletToEntity, error: entitiesUnverified } =
      await resolveEntityMap(Array.from(wallets));
    return {
      wallets,
      walletToEntity,
      scoreByWallet,
      statsByWallet,
      fundedByWallet,
      entitiesUnverified,
    };
  } catch {
    return empty;
  }
}

/**
 * Two-layer cached resolver for the smart-money set (wallets + entity map +
 * scores + conviction stats). Shared by getLiveBursts and detectBurstsForMints,
 * and exported for the alert webhook agent.
 *
 * Lookup order, cheapest first:
 *   1. In-process memo (no DB) — per-instance, ~5 min TTL.
 *   2. Persisted snapshot in indexer_state — ONE cheap single-row read; rebuilds
 *      the SAME SmartSet shape. Shared across all serverless instances, so a cold
 *      start gets a fresh set without the heavy resolve.
 *   3. Live resolveSmartSet() — the expensive paginate + cluster path. Runs only
 *      when both caches miss (~once per 5 min globally), and its result is
 *      written back to the snapshot for everyone else.
 *
 * Concurrent callers are coalesced onto one in-flight resolution. FULLY
 * RESILIENT: snapshot read/write failures are swallowed inside smart-set-cache
 * (returning null / no-op), so any failure transparently falls through to the
 * live resolve path and the returned SmartSet contract is unchanged.
 */
export async function getSmartWalletSet(): Promise<SmartSet> {
  const now = Date.now();
  if (smartSetCache && now - smartSetCache.at < SMART_SET_TTL_MS) {
    return smartSetCache.value;
  }
  if (smartSetInflight) return smartSetInflight;

  smartSetInflight = (async (): Promise<SmartSet> => {
    // Layer 2: cheap persisted snapshot (single-row read). Any failure or a
    // missing/stale row returns null and we fall through to the live resolve.
    try {
      const snap = await readSnapshot();
      if (snap && snap.wallets.size > 0) {
        smartSetCache = { value: snap, at: Date.now() };
        return snap;
      }
    } catch {
      // Snapshot layer must never break the feed; fall back to live resolve.
    }

    // Layer 3: heavy live resolve, then persist the snapshot for other instances.
    const value = await resolveSmartSet();
    // Only cache a non-empty result; empties may be transient failures and
    // shouldn't be pinned for the full TTL (and shouldn't overwrite a good snap).
    if (value.wallets.size > 0) {
      smartSetCache = { value, at: Date.now() };
      // Best-effort write; smart-set-cache swallows its own errors.
      try {
        await writeSnapshot(value);
      } catch {
        // Persisting is best-effort; next caller will simply re-resolve.
      }
    }
    return value;
  })().finally(() => {
    smartSetInflight = null;
  });

  return smartSetInflight;
}

interface BuyRow {
  wallet: string;
  entity: string;
  ts: number; // block_time in ms
  sol: number; // amount * price (0 when NaN)
  /**
   * On-chain trade price in SOL per token (trades.price = solAmount/amount),
   * or null when the row carried no usable price. This is the live, real price
   * for ANY token the indexer has ingested — including fresh pre-graduation
   * pump.fun tokens that DexScreener/GeckoTerminal don't list yet. Used to
   * compute a live entry→now price change that covers those tokens.
   */
  price: number | null;
}

/**
 * Group one token's time-ordered buys into ACCUMULATION STREAKS and emit a
 * single growing burst per streak that reaches ≥ minBuyers distinct entities.
 *
 * A streak is a run of consecutive buys where each buy's gap to the PREVIOUS
 * buy in the streak is ≤ windowSec — i.e. momentum never stalled for longer than
 * windowSec. As long as the streak continues, distinct entities, distinct
 * wallets, SOL total and windowEnd all KEEP ACCUMULATING, so when another smart
 * wallet buys after, its SOL is ADDED to the running total rather than starting
 * a separate fragmented card. windowStart is pinned to the streak's first buy,
 * which keeps the burst id stable as the streak grows. When the gap to the next
 * buy exceeds windowSec the streak ends and a new one begins.
 *
 * `windowSec` here means "max gap between consecutive buys to stay in one
 * accumulation streak" (NOT a fixed bucket length). The input rows are already
 * capped by the caller's lookback (`hours`/`lookbackMs`), so a perpetually-bought
 * token can't produce an unbounded streak.
 *
 * Shared by both the full live sweep and the mint-scoped real-time detector so
 * the dedup + streak logic stays identical (buy and sell sides alike).
 */
function detectBurstsForRows(
  mint: string,
  rowsUnsorted: BuyRow[],
  windowSec: number,
  minBuyers: number,
  scoreByWallet: Map<string, number>,
  now: number,
  side: 'buy' | 'sell' = 'buy',
  statsByWallet?: Map<
    string,
    { score: number; roiPct: number | null; winRate: number | null; realizedPnl: number }
  >,
  smartSetSize?: number,
  /**
   * FAIL-CLOSED (signal H2): when true the wallet→entity cluster map could not
   * be verified (wallet_links errored), so entity counts derived from raw
   * wallets are untrustworthy. We emit NOTHING for these rows rather than
   * over-report buyer/entity conviction from one actor's split wallets.
   */
  entitiesUnverified?: boolean,
  /**
   * SMART INHERITANCE map (inherited wallet -> funder). Optional: when absent
   * (e.g. an older snapshot) no inheritance fields are emitted. Used to flag
   * fresh wallets that are smart only because a proven smart wallet funded them.
   */
  fundedByWallet?: Map<string, string>
): LiveBurst[] {
  // FAIL CLOSED: if cluster verification failed we cannot trust entity counts,
  // so do not emit any bursts (prefer under-reporting to inflated conviction).
  if (entitiesUnverified) return [];
  const windowMs = windowSec * 1000;
  const out: LiveBurst[] = [];
  // Sort ascending by time (chunked reads / fetch order can interleave).
  const rows = rowsUnsorted.slice().sort((a, b) => a.ts - b.ts);

  interface Streak {
    startMs: number;
    endMs: number;
    prevMs: number;
    entities: Set<string>;
    wallets: Set<string>;
    solTotal: number;
    sampleBuyers: string[];
    sampleSeen: Set<string>;
    leadBuyer: string; // wallet of the FIRST (earliest) trade in the streak
    // On-chain trade price (SOL/token) at the EARLIEST and LATEST priced buy in
    // the streak. Rows are processed time-ascending, so the first priced row
    // sets firstPrice and every priced row updates lastPrice. null until a
    // priced row is seen (some rows may carry no usable price).
    firstPrice: number | null;
    lastPrice: number | null;
  }

  const tierFor = (w: string): string | null => {
    const score = scoreByWallet.get(w);
    return score == null ? null : tierFromScore(score);
  };

  /**
   * Conviction-scaled, transparent size SUGGESTION in SOL (NOT advice).
   *   tierWeight = sum over sampleBuyers of (S=3, A=2, B=1, else 0.5)
   *   raw        = 0.15 * tierWeight * log1p(solTotal)
   * then CLAMP to [0.1, 5] and round to 2 decimals. Modest by design.
   */
  const suggestSize = (tiers: (string | null)[], solTotal: number): number => {
    let tierWeight = 0;
    for (const t of tiers) tierWeight += t ? TIER_WEIGHT[t] ?? 0.5 : 0.5;
    const raw = 0.15 * tierWeight * Math.log1p(Math.max(0, solTotal));
    const clamped = Math.min(5, Math.max(0.1, raw));
    return Math.round(clamped * 100) / 100;
  };

  // A streak only becomes a burst once it holds ≥ minBuyers distinct entities;
  // emitted with the FULL accumulated totals so a sustained run is one card.
  const flush = (s: Streak): void => {
    if (s.entities.size < minBuyers) return;
    const tiers = s.sampleBuyers.map(tierFor);
    // SMART INHERITANCE: count distinct inherited wallets in the whole streak and
    // build a per-sampleBuyer funder list (null for non-inherited). Only computed
    // when a fundedByWallet map is supplied (absent on older snapshots).
    let inheritedBuyers: number | undefined;
    let sampleFunded: (string | null)[] | undefined;
    if (fundedByWallet && fundedByWallet.size > 0) {
      let n = 0;
      for (const w of s.wallets) if (fundedByWallet.has(w)) n++;
      inheritedBuyers = n;
      sampleFunded = s.sampleBuyers.map((w) => fundedByWallet.get(w) ?? null);
    }
    const buyerStats = s.sampleBuyers.map((w) => {
      const st = statsByWallet?.get(w);
      return {
        addr: w,
        tier: tierFor(w),
        roiPct: st ? st.roiPct : null,
        winRate: st ? st.winRate : null,
      };
    });
    out.push({
      // id keyed on (mint, side, streak's FIRST buy) -> stable as the streak
      // grows AND identical across callers regardless of their threshold.
      id: burstId(mint, side, s.startMs),
      mint,
      buyers: s.entities.size,
      buyerWallets: s.wallets.size,
      solTotal: Math.round(s.solTotal * 1e4) / 1e4,
      windowStart: new Date(s.startMs).toISOString(),
      windowEnd: new Date(s.endMs).toISOString(),
      sampleBuyers: s.sampleBuyers,
      wallets: Array.from(s.wallets),
      // Distinct buyer wallets for per-wallet attribution, capped (insertion
      // order is encounter order since s.wallets is a Set).
      allBuyers: Array.from(s.wallets).slice(0, MAX_ALL_BUYERS),
      side,
      tiers,
      buyerStats,
      inheritedBuyers,
      sampleFunded,
      leadBuyer: s.leadBuyer,
      leadTier: tierFor(s.leadBuyer),
      smartSetSize,
      suggestedSizeSol: suggestSize(tiers, s.solTotal),
      // Live on-chain entry/current prices straight from the burst's trades.
      firstBuyPriceSol: s.firstPrice,
      lastBuyPriceSol: s.lastPrice,
      // Settled once the streak can no longer absorb a new buy within windowSec.
      finalized: now - s.endMs > windowMs,
    });
  };

  let streak: Streak | null = null;
  for (const r of rows) {
    // Continue the streak while the gap to the PREVIOUS buy is within windowSec;
    // otherwise momentum stalled -> close this streak and open a fresh one.
    if (streak && r.ts - streak.prevMs > windowMs) {
      flush(streak);
      streak = null;
    }
    if (!streak) {
      streak = {
        startMs: r.ts,
        endMs: r.ts,
        prevMs: r.ts,
        entities: new Set(),
        wallets: new Set(),
        solTotal: 0,
        sampleBuyers: [],
        sampleSeen: new Set(),
        // rows are time-sorted ascending, so the streak's first row is the lead.
        leadBuyer: r.wallet,
        firstPrice: null,
        lastPrice: null,
      };
    }
    // Accumulate this buy into the running streak (SOL adds to the total).
    streak.endMs = r.ts;
    streak.prevMs = r.ts;
    streak.entities.add(r.entity);
    streak.wallets.add(r.wallet);
    streak.solTotal += r.sol;
    // Track the earliest/latest usable on-chain price in the streak (rows are
    // time-ascending). firstPrice is set once (entry); lastPrice tracks the most
    // recent priced buy (live current price for un-listed fresh tokens).
    if (r.price != null && Number.isFinite(r.price) && r.price > 0) {
      if (streak.firstPrice == null) streak.firstPrice = r.price;
      streak.lastPrice = r.price;
    }
    if (streak.sampleBuyers.length < 5 && !streak.sampleSeen.has(r.wallet)) {
      streak.sampleSeen.add(r.wallet);
      streak.sampleBuyers.push(r.wallet);
    }
  }
  if (streak) flush(streak);

  return out;
}

/** Composite "quality" score for a burst: tier-weighted conviction + size. */
function qualityScore(b: LiveBurst): number {
  let tierSum = 0;
  for (const t of b.tiers) tierSum += t ? TIER_WEIGHT[t] ?? 0.5 : 0.5;
  return tierSum + Math.log1p(Math.max(0, b.solTotal));
}

export async function getLiveBursts(opts: {
  windowSec?: number;
  minBuyers?: number;
  hours?: number;
  limit?: number;
}): Promise<LiveBurstsResult> {
  const windowSec = opts.windowSec ?? envInt('BURST_WINDOW_SEC', 180);
  const minBuyers = opts.minBuyers ?? 3;
  const hours = opts.hours ?? 6;
  const limit = opts.limit ?? 50;
  const generatedAt = new Date().toISOString();
  const empty: LiveBurstsResult = {
    generatedAt,
    windowSec,
    minBuyers,
    count: 0,
    bursts: [],
  };

  if (!isSupabaseConfigured()) return empty;

  try {
    const supabase = getSupabase();
    const now = Date.now();

    // 1. Resolve the smart-wallet set (memoized: wallets + entity map + scores).
    const { wallets, walletToEntity, scoreByWallet, statsByWallet, fundedByWallet, entitiesUnverified } =
      await getSmartWalletSet();
    const smartWallets = Array.from(wallets);
    if (smartWallets.length === 0) return empty;
    // FAIL CLOSED: cluster verification failed -> don't emit inflated bursts.
    if (entitiesUnverified) return empty;

    // Total distinct smart ENTITIES across the whole set, for coverage display:
    // map every smart wallet through the entity map (no cluster = own entity).
    const smartSetSize = countSmartEntities(wallets, walletToEntity);

    // 2. Pull recent BUY trades for those wallets. Fetch NEWEST first so that
    // when the MAX_TRADE_ROWS cap bites under load we keep the freshest rows
    // (a "live" feed must surface live bursts); the per-mint sweep re-sorts
    // ascending in memory anyway.
    const sinceMs = now - hours * 3_600_000;
    const sinceIso = new Date(sinceMs).toISOString();
    const trades: any[] = [];

    for (const group of chunk(smartWallets, WALLET_CHUNK)) {
      if (trades.length >= MAX_TRADE_ROWS) break;
      const remaining = MAX_TRADE_ROWS - trades.length;
      const tradeRead = await supabase
        .from('trades')
        .select('wallet, token_mint, amount, price, block_time')
        .eq('trade_type', 'BUY')
        .in('wallet', group)
        .gte('block_time', sinceIso)
        .order('block_time', { ascending: false })
        .limit(remaining);

      if (tradeRead.error) return empty;
      if (tradeRead.data) trades.push(...tradeRead.data);
    }

    // 3. Bucket buys per token.
    const byMint = new Map<string, BuyRow[]>();
    for (const t of trades) {
      const mint = String(t.token_mint);
      if (!mint) continue;
      const wallet = String(t.wallet);
      const amount = Number(t.amount);
      const price = Number(t.price);
      const sol =
        Number.isFinite(amount) && Number.isFinite(price) ? amount * price : 0;
      const ts = t.block_time ? new Date(t.block_time).getTime() : NaN;
      if (!Number.isFinite(ts)) continue;
      const entity = walletToEntity.get(wallet) ?? wallet;

      let rows = byMint.get(mint);
      if (!rows) {
        rows = [];
        byMint.set(mint, rows);
      }
      rows.push({ wallet, entity, ts, sol, price: Number.isFinite(price) ? price : null });
    }

    const bursts: LiveBurst[] = [];
    for (const [mint, rows] of byMint) {
      bursts.push(
        ...detectBurstsForRows(
          mint,
          rows,
          windowSec,
          minBuyers,
          scoreByWallet,
          now,
          'buy',
          statsByWallet,
          smartSetSize,
          entitiesUnverified,
          fundedByWallet
        )
      );
    }

    // 4. Newest first, capped at limit (default ordering; the route may re-rank).
    bursts.sort(
      (a, b) =>
        new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime()
    );
    const capped = bursts.slice(0, limit);

    return {
      generatedAt,
      windowSec,
      minBuyers,
      count: capped.length,
      bursts: capped,
    };
  } catch {
    return empty;
  }
}

/**
 * Mint-SCOPED burst sweep for real-time alerts: given a small set of mints
 * (e.g. those just seen in a webhook), pull only those mints' recent smart buys
 * over a short lookback and detect bursts using the same entity-dedup
 * accumulation-streak logic as getLiveBursts. Tiers are populated; market
 * enrichment is left to the
 * caller (optional here). Degrades to an empty list on any failure.
 *
 * Single-side convenience wrapper around detectBurstsForMintsBothSides (which
 * does ONE coalesced trade query). Kept for callers that only need one side.
 */
export async function detectBurstsForMints(
  mints: string[],
  opts?: {
    windowSec?: number;
    minBuyers?: number;
    lookbackMs?: number;
    side?: 'buy' | 'sell';
  }
): Promise<LiveBurst[]> {
  const side = opts?.side ?? 'buy';
  const both = await detectBurstsForMintsBothSides(mints, {
    windowSec: opts?.windowSec,
    lookbackMs: opts?.lookbackMs,
    minBuyBuyers: side === 'buy' ? opts?.minBuyers : undefined,
    minSellEntities: side === 'sell' ? opts?.minBuyers : undefined,
  });
  return side === 'sell' ? both.sell : both.buy;
}

/**
 * COALESCED mint-scoped burst sweep that detects BOTH buy and sell bursts from a
 * SINGLE trades query (perf): instead of two queries (one per trade_type), pull
 * BUY and SELL rows together via `.in('trade_type', ['BUY','SELL'])` over the
 * mints/window, then split BUY vs SELL in memory and run the SAME per-side
 * detection. This halves the hot-path trade reads for the webhook, which needs
 * both sides. Buy-burst and sell-burst results are identical to running the two
 * single-side passes separately. Degrades to empty lists on any failure.
 */
export async function detectBurstsForMintsBothSides(
  mints: string[],
  opts?: {
    windowSec?: number;
    lookbackMs?: number;
    minBuyBuyers?: number;
    minSellEntities?: number;
  }
): Promise<{ buy: LiveBurst[]; sell: LiveBurst[] }> {
  const windowSec = opts?.windowSec ?? envInt('BURST_WINDOW_SEC', 180);
  const lookbackMs = opts?.lookbackMs ?? 5 * 60 * 1000;
  const minBuyBuyers = opts?.minBuyBuyers ?? 3;
  const minSellEntities = opts?.minSellEntities ?? 3;

  const empty = { buy: [] as LiveBurst[], sell: [] as LiveBurst[] };
  const uniqueMints = Array.from(
    new Set(mints.filter((m) => typeof m === 'string' && m))
  );
  if (uniqueMints.length === 0 || !isSupabaseConfigured()) return empty;

  try {
    const supabase = getSupabase();
    const now = Date.now();

    const { wallets, walletToEntity, scoreByWallet, statsByWallet, fundedByWallet, entitiesUnverified } =
      await getSmartWalletSet();
    if (wallets.size === 0) return empty;
    // FAIL CLOSED: cluster verification failed -> don't emit inflated bursts.
    if (entitiesUnverified) return empty;

    const smartSetSize = countSmartEntities(wallets, walletToEntity);
    const sinceIso = new Date(now - lookbackMs).toISOString();

    // ONE coalesced query per mint-chunk: pull BUY *and* SELL together (newest
    // first), then split by side in memory. Halves the per-webhook trade reads
    // vs two single-side queries. Filtered to smart wallets in memory below.
    const trades: any[] = [];
    for (const group of chunk(uniqueMints, WALLET_CHUNK)) {
      const tradeRead = await supabase
        .from('trades')
        .select('wallet, token_mint, amount, price, block_time, trade_type')
        .in('trade_type', ['BUY', 'SELL'])
        .in('token_mint', group)
        .gte('block_time', sinceIso)
        .order('block_time', { ascending: false })
        .limit(MAX_TRADE_ROWS);

      if (tradeRead.error) return empty;
      if (tradeRead.data) trades.push(...tradeRead.data);
    }

    // Split rows per mint AND per side in one pass.
    const buyByMint = new Map<string, BuyRow[]>();
    const sellByMint = new Map<string, BuyRow[]>();
    for (const t of trades) {
      const wallet = String(t.wallet);
      if (!wallets.has(wallet)) continue; // smart-money only
      const mint = String(t.token_mint);
      if (!mint) continue;
      const amount = Number(t.amount);
      const price = Number(t.price);
      const sol =
        Number.isFinite(amount) && Number.isFinite(price) ? amount * price : 0;
      const ts = t.block_time ? new Date(t.block_time).getTime() : NaN;
      if (!Number.isFinite(ts)) continue;
      const entity = walletToEntity.get(wallet) ?? wallet;

      const target = t.trade_type === 'SELL' ? sellByMint : buyByMint;
      let rows = target.get(mint);
      if (!rows) {
        rows = [];
        target.set(mint, rows);
      }
      rows.push({ wallet, entity, ts, sol, price: Number.isFinite(price) ? price : null });
    }

    const detect = (
      byMint: Map<string, BuyRow[]>,
      side: 'buy' | 'sell',
      minBuyers: number
    ): LiveBurst[] => {
      const out: LiveBurst[] = [];
      for (const [mint, rows] of byMint) {
        out.push(
          ...detectBurstsForRows(
            mint,
            rows,
            windowSec,
            minBuyers,
            scoreByWallet,
            now,
            side,
            statsByWallet,
            smartSetSize,
            entitiesUnverified,
            fundedByWallet
          )
        );
      }
      out.sort(
        (a, b) =>
          new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime()
      );
      return out;
    };

    return {
      buy: detect(buyByMint, 'buy', minBuyBuyers),
      sell: detect(sellByMint, 'sell', minSellEntities),
    };
  } catch {
    return empty;
  }
}

export { qualityScore };
