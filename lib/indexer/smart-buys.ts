/**
 * SMART-MONEY BUY FLOW
 *
 * Surfaces the tokens that multiple VERIFIED smart wallets are buying right now.
 * The product framing: "smart money is rotating into X" — a strong signal when
 * several independently-curated wallets all open positions in the same token
 * inside a short window.
 *
 * Pipeline:
 *   1. Resolve the smart-wallet set (verified wallets that clear the curation
 *      gate in lib/indexer/curation.ts).
 *   2. Pull their recent BUY trades.
 *   3. Aggregate by token, ranking by how many DISTINCT smart wallets bought it.
 *
 * Degrades gracefully: if Supabase isn't configured, or the verified/roi_pct
 * columns don't exist yet, it returns an empty token list instead of throwing.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { fetchTokenPricesSol } from '../prices/price-oracle';
import { getBroadSmartCriteria, isSmartWallet } from './curation';
import { buildClusters } from './clusters';

export interface SmartBuyToken {
  mint: string;
  /**
   * Number of distinct smart-money ENTITIES that bought this token. Wallets that
   * belong to the same funding cluster (lib/indexer/clusters.ts) collapse to a
   * single entity, so 5 wallets behind 1 trader count as 1 — an honest measure
   * of independent conviction. Falls back to the raw distinct-wallet count if
   * cluster resolution is unavailable.
   */
  distinctSmartBuyers: number;
  /**
   * Raw count of distinct buyer WALLET addresses (pre-cluster-dedup), so the UI
   * can show "5 wallets · 2 entities". Optional/backward-compatible.
   */
  distinctSmartBuyerWallets?: number;
  buys: number;
  solVolume: number;
  firstBuy: string | null;
  lastBuy: string | null;
  sampleBuyers: string[];
  /** Per-hour count of smart BUY trades across the window (oldest → newest). */
  momentum: number[];
  /**
   * Distinct smart-money ENTITIES that SOLD this token in the same window
   * (same cluster-collapse as distinctSmartBuyers). Falls back to raw distinct
   * wallet count if cluster resolution is unavailable.
   */
  sellers: number;
  /** Raw count of distinct seller WALLET addresses (pre-cluster-dedup). Optional. */
  sellerWallets?: number;
  /** SOL value of smart SELL trades in the window. */
  solSold: number;
  /** Net SOL flow from smart money: solVolume (buys) − solSold (sells). */
  netSolFlow: number;
  /** Token price (in SOL) at the first smart buy, or null if unknown. */
  firstBuyPriceSol: number | null;
  /** % change between firstBuyPriceSol and the latest known price, or null. */
  priceChangeSincePct: number | null;
}

export interface SmartMoneyBuysResult {
  generatedAt: string;
  hours: number;
  count: number;
  tokens: SmartBuyToken[];
}

const WALLET_CHUNK = 200; // Supabase .in() list size per query
const MAX_TRADE_ROWS = 3000; // hard cap on rows pulled across all chunks

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Build a wallet -> entity-id map for the given wallet set, where wallets in the
 * same funding cluster share an entity id (the cluster's representative member).
 *
 * Strategy / cost: we pull the `wallet_links` funding edges that touch the
 * wallet set in a handful of batched .in() queries (NOT one BFS per wallet via
 * getClusterFor — that would be N round-trips and risk the 60s budget), then run
 * the pure, in-memory union-find from clusters.ts (buildClusters) over those
 * edges. Wallets with no edges simply never appear in the map and are treated as
 * their own entity by the caller.
 *
 * Degrades gracefully: any query/error (table missing, RLS, transient) returns
 * an empty map, so distinct counts fall back to raw distinct-wallet counts and
 * the feed keeps working.
 */
async function resolveEntityMap(
  wallets: string[]
): Promise<Map<string, string>> {
  const entityMap = new Map<string, string>();
  if (wallets.length === 0 || !isSupabaseConfigured()) return entityMap;

  try {
    const supabase = getSupabase();
    const edges: { source: string; target: string }[] = [];

    // Fetch edges where either endpoint is one of our smart wallets. Two batched
    // queries per chunk (source.in / target.in) keep the .in() lists bounded.
    for (const group of chunk(wallets, WALLET_CHUNK)) {
      for (const col of ['source', 'target'] as const) {
        const { data, error } = await supabase
          .from('wallet_links')
          .select('source, target')
          .in(col, group);
        if (error) return new Map(); // degrade to raw counts
        for (const row of data ?? []) {
          const src = (row as any).source as string;
          const tgt = (row as any).target as string;
          if (src && tgt) edges.push({ source: src, target: tgt });
        }
      }
    }

    if (edges.length === 0) return entityMap;

    // Pure union-find: wallet -> sorted cluster member list. Use the first
    // (sorted) member as the stable entity id for the whole cluster.
    const clusters = buildClusters(edges);
    for (const [wallet, members] of clusters) {
      entityMap.set(wallet, members[0] ?? wallet);
    }
    return entityMap;
  } catch {
    return new Map(); // never fail the feed on cluster issues
  }
}

export async function getSmartMoneyBuys(
  opts?: { hours?: number; limit?: number }
): Promise<SmartMoneyBuysResult> {
  const hours = opts?.hours ?? 24;
  const limit = opts?.limit ?? 50;
  const generatedAt = new Date().toISOString();
  const empty: SmartMoneyBuysResult = { generatedAt, hours, count: 0, tokens: [] };

  if (!isSupabaseConfigured()) return empty;

  try {
    const supabase = getSupabase();
    // INCLUSION uses the BROAD gate so more smart wallets feed the buy flow.
    const criteria = getBroadSmartCriteria();
    const now = Date.now();

    // 1. Resolve the smart-wallet set. Only verified (deep-scanned) wallets have
    // a trustworthy all-time ROI, so we restrict to them and then apply the
    // full curation gate in JS.
    const statCols =
      'wallet, realized_pnl, roi_pct, invested_sol, win_rate, total_trades, tokens_traded, last_trade_at, seeded';
    const statRead = await supabase
      .from('wallet_stats')
      .select(statCols)
      .eq('verified', true);

    // If verified/roi_pct columns are missing (or any other query error),
    // degrade to an empty result rather than crashing the endpoint.
    if (statRead.error || !statRead.data) return empty;

    const smartWallets: string[] = statRead.data
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
      .map((r: any) => String(r.wallet));

    if (smartWallets.length === 0) return empty;

    // 1b. Build a wallet -> entity-cluster map so wallets controlled by the same
    // trader collapse into one "entity" when we count distinct buyers/sellers.
    //
    // Tradeoff: clusters.ts exposes getClusterFor(address), but that runs a
    // bounded BFS per address — calling it once per smart wallet would be N
    // round-trips and could blow the Vercel 60s budget. Instead we fetch the
    // wallet_links funding edges that touch the smart-wallet set in a few batched
    // .in() queries, then run the pure in-memory union-find (buildClusters) once.
    // This captures direct edges among smart wallets (the case that actually
    // inflates the signal) cheaply. We deliberately do NOT expand multi-hop
    // through non-smart intermediaries here — that's the expensive BFS path and
    // is overkill for honest buyer counting. On any failure we leave the map
    // empty and every wallet stays its own entity (i.e. raw counts), so the feed
    // never fails on cluster issues.
    const walletToEntity = await resolveEntityMap(smartWallets);

    // 2. Pull recent BUY + SELL trades for those wallets, newest first, across
    // chunks. We need SELLs to compute net buy/sell pressure for each token.
    const sinceMs = now - hours * 3_600_000;
    const sinceIso = new Date(sinceMs).toISOString();
    const trades: any[] = [];

    for (const group of chunk(smartWallets, WALLET_CHUNK)) {
      if (trades.length >= MAX_TRADE_ROWS) break;
      const remaining = MAX_TRADE_ROWS - trades.length;
      const tradeRead = await supabase
        .from('trades')
        .select('wallet, token_mint, trade_type, amount, price, block_time')
        .in('trade_type', ['BUY', 'SELL'])
        .in('wallet', group)
        .gte('block_time', sinceIso)
        .order('block_time', { ascending: false })
        .limit(remaining);

      if (tradeRead.error) return empty;
      if (tradeRead.data) trades.push(...tradeRead.data);
    }

    // 3. Aggregate by token_mint. Buys and sells are tracked separately so we
    // can surface net pressure; the momentum series buckets BUY counts by hour.
    const buckets = Math.max(1, Math.min(168, Math.round(hours)));
    const bucketMs = (hours * 3_600_000) / buckets;

    interface Agg {
      mint: string;
      buyers: Set<string>; // raw distinct buyer wallet addresses
      buyerEntities: Set<string>; // distinct entity (cluster) ids of buyers
      buys: number;
      solVolume: number;
      firstBuy: number | null;
      lastBuy: number | null;
      firstBuyPrice: number | null; // price (SOL) recorded at the firstBuy trade
      sellers: Set<string>; // raw distinct seller wallet addresses
      sellerEntities: Set<string>; // distinct entity (cluster) ids of sellers
      solSold: number;
      momentum: number[]; // per-hour BUY counts, oldest → newest
      sampleBuyers: string[];
      sampleSeen: Set<string>;
    }
    const byMint = new Map<string, Agg>();

    for (const t of trades) {
      const mint = String(t.token_mint);
      if (!mint) continue;
      const wallet = String(t.wallet);
      const type = String(t.trade_type);
      const amount = Number(t.amount);
      const price = Number(t.price);
      const sol = Number.isFinite(amount) && Number.isFinite(price) ? amount * price : 0;
      const ts = t.block_time ? new Date(t.block_time).getTime() : NaN;

      let agg = byMint.get(mint);
      if (!agg) {
        agg = {
          mint,
          buyers: new Set(),
          buyerEntities: new Set(),
          buys: 0,
          solVolume: 0,
          firstBuy: null,
          lastBuy: null,
          firstBuyPrice: null,
          sellers: new Set(),
          sellerEntities: new Set(),
          solSold: 0,
          momentum: new Array(buckets).fill(0),
          sampleBuyers: [],
          sampleSeen: new Set(),
        };
        byMint.set(mint, agg);
      }

      // Collapse same-entity wallets: a wallet's entity id is its cluster, or
      // itself when it has no funding edges in the smart set.
      const entity = walletToEntity.get(wallet) ?? wallet;

      if (type === 'SELL') {
        agg.sellers.add(wallet);
        agg.sellerEntities.add(entity);
        agg.solSold += sol;
        continue;
      }

      // BUY
      agg.buyers.add(wallet);
      agg.buyerEntities.add(entity);
      agg.buys += 1;
      agg.solVolume += sol;
      if (Number.isFinite(ts)) {
        if (agg.firstBuy == null || ts < agg.firstBuy) {
          agg.firstBuy = ts;
          agg.firstBuyPrice = Number.isFinite(price) && price > 0 ? price : agg.firstBuyPrice;
        }
        if (agg.lastBuy == null || ts > agg.lastBuy) agg.lastBuy = ts;
        // Bucket this buy into the momentum series.
        let idx = Math.floor((ts - sinceMs) / bucketMs);
        if (idx < 0) idx = 0;
        if (idx >= buckets) idx = buckets - 1;
        agg.momentum[idx] += 1;
      }
      if (agg.sampleBuyers.length < 5 && !agg.sampleSeen.has(wallet)) {
        agg.sampleSeen.add(wallet);
        agg.sampleBuyers.push(wallet);
      }
    }

    // Keep only tokens with at least one smart BUY (a SELL-only token isn't a
    // "buying" signal). Then rank and cap before the price lookup so we batch
    // the oracle over just the returned set.
    const ranked = Array.from(byMint.values())
      .filter((a) => a.buyers.size > 0)
      .sort(
        (a, b) =>
          b.buyerEntities.size - a.buyerEntities.size || b.solVolume - a.solVolume
      )
      .slice(0, limit);

    // 4. Resolve current SOL prices (one batched oracle call) so we can compute
    // how far each token has run since the first smart buy. Failures degrade to
    // null rather than throwing.
    //
    // NOTE (audit, DexScreener double-fetch): the /api/smart-money/buying route
    // separately enriches these same mints via getTokenMeta (also DexScreener).
    // We deliberately KEEP this oracle call: getTokenMeta exposes priceUsd, not a
    // SOL-denominated price, and converting it would require re-deriving a
    // SOL/USD reference (which the oracle already does internally from the SAME
    // pair set). firstBuyPriceSol/priceChangeSincePct here are SOL-unit and must
    // stay on the oracle to preserve numeric behavior; collapsing the two calls
    // is not clean without reworking getTokenMeta to surface priceSol. Both layers
    // are ~60s/~2min cached, so the practical duplication is one cached read.
    let priceMap = new Map<string, number>();
    try {
      priceMap = await fetchTokenPricesSol(ranked.map((a) => a.mint));
    } catch {
      priceMap = new Map();
    }

    const tokens: SmartBuyToken[] = ranked.map((a) => {
      const solVolume = Math.round(a.solVolume * 1e4) / 1e4;
      const solSold = Math.round(a.solSold * 1e4) / 1e4;
      const firstBuyPriceSol = a.firstBuyPrice;
      const current = priceMap.get(a.mint);
      let priceChangeSincePct: number | null = null;
      if (
        firstBuyPriceSol != null &&
        firstBuyPriceSol > 0 &&
        current != null &&
        Number.isFinite(current)
      ) {
        priceChangeSincePct = ((current - firstBuyPriceSol) / firstBuyPriceSol) * 100;
        priceChangeSincePct = Math.round(priceChangeSincePct * 100) / 100;
      }
      return {
        mint: a.mint,
        // Entity count is the honest primary signal; raw wallet count kept
        // alongside for "N wallets · M entities" UI.
        distinctSmartBuyers: a.buyerEntities.size,
        distinctSmartBuyerWallets: a.buyers.size,
        buys: a.buys,
        solVolume,
        firstBuy: a.firstBuy == null ? null : new Date(a.firstBuy).toISOString(),
        lastBuy: a.lastBuy == null ? null : new Date(a.lastBuy).toISOString(),
        sampleBuyers: a.sampleBuyers,
        momentum: a.momentum,
        sellers: a.sellerEntities.size,
        sellerWallets: a.sellers.size,
        solSold,
        netSolFlow: Math.round((solVolume - solSold) * 1e4) / 1e4,
        firstBuyPriceSol:
          firstBuyPriceSol == null ? null : Math.round(firstBuyPriceSol * 1e12) / 1e12,
        priceChangeSincePct,
      };
    });

    return { generatedAt, hours, count: tokens.length, tokens };
  } catch {
    return empty;
  }
}
