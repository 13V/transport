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
 *      one trader collapse to a single entity.
 *   2. Pull their recent BUY trades over the last `hours`.
 *   3. Per token, sort buys ascending by time and slide a `windowSec` window;
 *      a window holding ≥ `minBuyers` DISTINCT ENTITIES is a burst. A
 *      non-overlapping sweep advances past each fired window so each token
 *      emits distinct bursts rather than dozens of overlapping near-duplicates.
 *
 * Degrades gracefully: any failure (Supabase unconfigured, missing columns,
 * cluster resolution error) returns an empty burst list instead of throwing.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getSmartCriteria, isSmartWallet } from './curation';
import { buildClusters } from './clusters';

export interface LiveBurst {
  /** `${mint}-${windowStartMs}` — stable per (token, burst-start). */
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
  // Enrichment fields (left undefined here; the route fills these in).
  symbol?: string;
  name?: string;
  icon?: string;
  icons?: string[];
  tiers?: Record<string, string | undefined>;
}

export interface LiveBurstsResult {
  generatedAt: string;
  windowSec: number;
  minBuyers: number;
  count: number;
  bursts: LiveBurst[];
}

const WALLET_CHUNK = 200; // Supabase .in() list size per query
const MAX_TRADE_ROWS = 3000; // hard cap on rows pulled across all chunks

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

interface BuyRow {
  wallet: string;
  entity: string;
  ts: number; // block_time in ms
  sol: number; // amount * price (0 when NaN)
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
    const criteria = getSmartCriteria();
    const now = Date.now();

    // 1. Resolve the smart-wallet set: verified (deep-scanned) wallets that
    // clear the full curation gate in JS.
    const statCols =
      'wallet, realized_pnl, roi_pct, invested_sol, win_rate, total_trades, tokens_traded, last_trade_at, seeded';
    const statRead = await supabase
      .from('wallet_stats')
      .select(statCols)
      .eq('verified', true);

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

    // 1b. wallet -> entity (cluster) map so co-funded wallets count once.
    const walletToEntity = await resolveEntityMap(smartWallets);

    // 2. Pull recent BUY trades for those wallets, ordered by block_time so the
    // per-token sweep gets time-ordered rows. Chunk the .in() like smart-buys.
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
        .order('block_time', { ascending: true })
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

    const windowMs = windowSec * 1000;
    const bursts: LiveBurst[] = [];

    for (const [mint, rowsUnsorted] of byMint) {
      // Sort this token's buys ascending by time (chunked reads can interleave).
      const rows = rowsUnsorted.sort((a, b) => a.ts - b.ts);

      // Non-overlapping sweep: for each start index, gather all buys within
      // [rows[i].ts, rows[i].ts + windowMs]. If they cover ≥ minBuyers distinct
      // entities, emit a burst and jump the start pointer past the window's last
      // buy so we don't emit overlapping near-duplicates for the same cluster of
      // activity. Otherwise advance one buy at a time.
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
          bursts.push({
            id: `${mint}-${windowStartMs}`,
            mint,
            buyers: entities.size,
            buyerWallets: wallets.size,
            solTotal: Math.round(solTotal * 1e4) / 1e4,
            windowStart: new Date(windowStartMs).toISOString(),
            windowEnd: new Date(windowEndMs).toISOString(),
            sampleBuyers,
          });
          // Advance past this window's buys to keep bursts non-overlapping.
          i = j;
        } else {
          i += 1;
        }
      }
    }

    // 4. Newest first, capped at limit.
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
