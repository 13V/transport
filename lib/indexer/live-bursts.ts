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
 *   3. Per token, sort buys ascending by time and slide a `windowSec` window;
 *      a window holding ≥ `minBuyers` DISTINCT ENTITIES is a burst. A
 *      non-overlapping sweep advances past each fired window so each token
 *      emits distinct bursts rather than dozens of overlapping near-duplicates.
 *
 * Degrades gracefully: any failure (Supabase unconfigured, missing columns,
 * cluster resolution error) returns an empty burst list instead of throwing.
 */

import { createHash } from 'crypto';
import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getSmartCriteria, isSmartWallet } from './curation';
import { buildClusters } from './clusters';
import { tierFromScore } from '../format';

export interface LiveBurst {
  /**
   * Stable content hash of (mint, windowStartMs, minBuyers, windowSec). Stays
   * constant as the window absorbs more buys, so clients can dedupe reliably.
   */
  id: string;
  mint: string;
  /** Distinct smart-money ENTITIES (cluster-deduped) in the burst window. */
  buyers: number;
  /** Raw distinct buyer WALLET addresses in the window (pre-cluster-dedup). */
  buyerWallets: number;
  /** Sum of amount*price (SOL value) of buys in the window. */
  solTotal: number;
  /** ISO timestamp of the first buy in the burst window. */
  windowStart: string;
  /** ISO timestamp of the last buy in the burst window. */
  windowEnd: string;
  /** Up to 5 distinct buyer wallet addresses from the window. */
  sampleBuyers: string[];
  /**
   * FULL distinct buyer/seller wallet address set in the window (pre-cluster).
   * Used for per-user watchlist matching; `sampleBuyers` stays the 5-cap UI set.
   */
  wallets: string[];
  /** Which side of the trade this burst represents. Defaults to 'buy'. */
  side: 'buy' | 'sell';
  /**
   * Tier string (S/A/B/C) or null per buyer, ALIGNED to `sampleBuyers` order.
   * Derived from each wallet's composite score via tierFromScore.
   */
  tiers: (string | null)[];
  /**
   * True once the window can no longer absorb new buys (windowEnd is older than
   * windowSec before now), i.e. the burst is settled. False while still live.
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
}

const WALLET_CHUNK = 200; // Supabase .in() list size per query
const MAX_TRADE_ROWS = 3000; // hard cap on rows pulled across all chunks

// Tier weights for the "quality" composite ranking.
const TIER_WEIGHT: Record<string, number> = { S: 3, A: 2, B: 1, C: 0.5 };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Stable id: short content hash so the id doesn't drift as the window grows. */
function burstId(
  mint: string,
  windowStartMs: number,
  minBuyers: number,
  windowSec: number
): string {
  const h = createHash('sha1')
    .update(`${mint}|${windowStartMs}|${minBuyers}|${windowSec}`)
    .digest('hex');
  return h.slice(0, 16);
}

/**
 * Build a wallet -> entity-id map where wallets in the same funding cluster
 * share an entity id (the cluster's stable representative member). Mirrors the
 * approach in smart-buys.ts: fetch the wallet_links edges touching the smart
 * set in a few batched .in() queries, then run the pure in-memory union-find
 * from clusters.ts. Degrades to an empty map (raw wallets = own entity) on any
 * error so burst counting never fails on cluster issues.
 */
async function resolveEntityMap(wallets: string[]): Promise<Map<string, string>> {
  const entityMap = new Map<string, string>();
  if (wallets.length === 0 || !isSupabaseConfigured()) return entityMap;

  try {
    const supabase = getSupabase();
    const edges: { source: string; target: string }[] = [];

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

    const clusters = buildClusters(edges);
    for (const [wallet, members] of clusters) {
      entityMap.set(wallet, members[0] ?? wallet);
    }
    return entityMap;
  } catch {
    return new Map(); // never fail the feed on cluster issues
  }
}

/**
 * Resolve the smart-wallet set + entity map + per-wallet score, memoized
 * in-process with a short TTL. The underlying data (verified wallet stats +
 * funding clusters) only changes on cron cadence, so /live and the alert
 * webhook can share one resolution instead of each re-running ~25 DB queries.
 */
const SMART_SET_TTL_MS = 60_000;
let smartSetCache: { value: SmartSet; at: number } | null = null;
let smartSetInflight: Promise<SmartSet> | null = null;

async function resolveSmartSet(): Promise<SmartSet> {
  const empty: SmartSet = {
    wallets: new Set(),
    walletToEntity: new Map(),
    scoreByWallet: new Map(),
  };
  if (!isSupabaseConfigured()) return empty;

  try {
    const supabase = getSupabase();
    const criteria = getSmartCriteria();
    const now = Date.now();

    // Only verified (deep-scanned) wallets have trustworthy stats; apply the
    // full curation gate in JS. `score` is selected so we can attach tiers.
    const statCols =
      'wallet, score, realized_pnl, roi_pct, invested_sol, win_rate, total_trades, tokens_traded, last_trade_at, seeded';
    const statRead = await supabase
      .from('wallet_stats')
      .select(statCols)
      .eq('verified', true);

    if (statRead.error || !statRead.data) return empty;

    const wallets = new Set<string>();
    const scoreByWallet = new Map<string, number>();
    for (const r of statRead.data as any[]) {
      const ok = isSmartWallet(
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
      );
      if (!ok) continue;
      const wallet = String(r.wallet);
      wallets.add(wallet);
      const score = Number(r.score);
      if (Number.isFinite(score)) scoreByWallet.set(wallet, score);
    }

    if (wallets.size === 0) return empty;

    const walletToEntity = await resolveEntityMap(Array.from(wallets));
    return { wallets, walletToEntity, scoreByWallet };
  } catch {
    return empty;
  }
}

/**
 * Memoized resolver for the smart-money set (wallets + entity map + scores).
 * Shared by getLiveBursts and detectBurstsForMints, and exported for the alert
 * webhook agent. Coalesces concurrent callers onto one in-flight resolution.
 */
export async function getSmartWalletSet(): Promise<SmartSet> {
  const now = Date.now();
  if (smartSetCache && now - smartSetCache.at < SMART_SET_TTL_MS) {
    return smartSetCache.value;
  }
  if (smartSetInflight) return smartSetInflight;

  smartSetInflight = resolveSmartSet()
    .then((value) => {
      // Only cache a non-empty result; empties may be transient failures and
      // shouldn't be pinned for the full TTL.
      if (value.wallets.size > 0) smartSetCache = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      smartSetInflight = null;
    });

  return smartSetInflight;
}

interface BuyRow {
  wallet: string;
  entity: string;
  ts: number; // block_time in ms
  sol: number; // amount * price (0 when NaN)
}

/**
 * Slide a non-overlapping window over one token's time-ordered buys and emit a
 * burst whenever a window covers ≥ minBuyers distinct entities. Shared by both
 * the full live sweep and the mint-scoped real-time detector so the dedup +
 * window logic stays identical.
 */
function detectBurstsForRows(
  mint: string,
  rowsUnsorted: BuyRow[],
  windowSec: number,
  minBuyers: number,
  scoreByWallet: Map<string, number>,
  now: number,
  side: 'buy' | 'sell' = 'buy'
): LiveBurst[] {
  const windowMs = windowSec * 1000;
  const out: LiveBurst[] = [];
  // Sort ascending by time (chunked reads / fetch order can interleave).
  const rows = rowsUnsorted.slice().sort((a, b) => a.ts - b.ts);

  let i = 0;
  while (i < rows.length) {
    const startTs = rows[i].ts;
    const endLimit = startTs + windowMs;
    let j = i;
    while (j < rows.length && rows[j].ts <= endLimit) j++;
    // Window is rows[i .. j-1].
    const entities = new Set<string>();
    const wallets = new Set<string>();
    let solTotal = 0;
    const sampleBuyers: string[] = [];
    const sampleSeen = new Set<string>();
    for (let k = i; k < j; k++) {
      const r = rows[k];
      entities.add(r.entity);
      wallets.add(r.wallet);
      solTotal += r.sol;
      if (sampleBuyers.length < 5 && !sampleSeen.has(r.wallet)) {
        sampleSeen.add(r.wallet);
        sampleBuyers.push(r.wallet);
      }
    }

    if (entities.size >= minBuyers) {
      const windowStartMs = rows[i].ts;
      const windowEndMs = rows[j - 1].ts;
      const tiers = sampleBuyers.map((w) => {
        const s = scoreByWallet.get(w);
        return s == null ? null : tierFromScore(s);
      });
      out.push({
        id: burstId(mint, windowStartMs, minBuyers, windowSec),
        mint,
        buyers: entities.size,
        buyerWallets: wallets.size,
        solTotal: Math.round(solTotal * 1e4) / 1e4,
        windowStart: new Date(windowStartMs).toISOString(),
        windowEnd: new Date(windowEndMs).toISOString(),
        sampleBuyers,
        wallets: Array.from(wallets),
        side,
        tiers,
        finalized: windowEndMs < now - windowMs,
      });
      // Advance past this window's buys to keep bursts non-overlapping.
      i = j;
    } else {
      i += 1;
    }
  }

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
  const windowSec = opts.windowSec ?? 30;
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
    const { wallets, walletToEntity, scoreByWallet } = await getSmartWalletSet();
    const smartWallets = Array.from(wallets);
    if (smartWallets.length === 0) return empty;

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
      rows.push({ wallet, entity, ts, sol });
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
          now
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
 * over a short lookback and detect bursts using the same entity-dedup window
 * logic as getLiveBursts. Tiers are populated; market enrichment is left to the
 * caller (optional here). Degrades to an empty list on any failure.
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
  const windowSec = opts?.windowSec ?? 30;
  const minBuyers = opts?.minBuyers ?? 3;
  const lookbackMs = opts?.lookbackMs ?? 5 * 60 * 1000;
  const side = opts?.side ?? 'buy';
  const tradeType = side === 'sell' ? 'SELL' : 'BUY';

  const uniqueMints = Array.from(
    new Set(mints.filter((m) => typeof m === 'string' && m))
  );
  if (uniqueMints.length === 0 || !isSupabaseConfigured()) return [];

  try {
    const supabase = getSupabase();
    const now = Date.now();

    const { wallets, walletToEntity, scoreByWallet } = await getSmartWalletSet();
    if (wallets.size === 0) return [];

    const sinceIso = new Date(now - lookbackMs).toISOString();

    // Pull recent trades (BUY or SELL per `side`) for the given mints, newest
    // first, then filter to smart wallets in memory. Scoping by mint (a short
    // .in() list) keeps this cheap enough for the per-webhook hot path.
    const trades: any[] = [];
    for (const group of chunk(uniqueMints, WALLET_CHUNK)) {
      const tradeRead = await supabase
        .from('trades')
        .select('wallet, token_mint, amount, price, block_time')
        .eq('trade_type', tradeType)
        .in('token_mint', group)
        .gte('block_time', sinceIso)
        .order('block_time', { ascending: false })
        .limit(MAX_TRADE_ROWS);

      if (tradeRead.error) return [];
      if (tradeRead.data) trades.push(...tradeRead.data);
    }

    const byMint = new Map<string, BuyRow[]>();
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

      let rows = byMint.get(mint);
      if (!rows) {
        rows = [];
        byMint.set(mint, rows);
      }
      rows.push({ wallet, entity, ts, sol });
    }

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
          side
        )
      );
    }

    out.sort(
      (a, b) =>
        new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime()
    );
    return out;
  } catch {
    return [];
  }
}

export { qualityScore };
