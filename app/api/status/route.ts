/**
 * PIPELINE STATUS — one link to see the whole system at a glance.
 *
 *   GET /api/status
 *
 * No manual steps: shows the last indexer + refine runs, how many wallets are
 * indexed, how many clear the smart-money gate, and the current top of the
 * curated list. If this looks healthy, the leaderboard and /api/smart-money/list
 * are good — nothing to paste, nothing to trigger by hand.
 */

import { NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../lib/supabase-client';
import { getBroadSmartCriteria, isSmartWallet } from '../../../lib/indexer/curation';
import { fetchAllRows } from '../../../lib/db-paginate';

export const dynamic = 'force-dynamic';

// Cache key + TTL for the EXPENSIVE smart-wallet scan. The smart count (and the
// curated top-10 it produces) is the only field on this endpoint that requires a
// full pass over every gate-passing row — the rest are cheap indexed head/single
// reads. We persist the derived numbers as a JSON blob in `indexer_state` and
// serve them for STATUS_CACHE_TTL_MS so a frequently-hit public status endpoint
// doesn't re-scan the gate set on every request.
const STATUS_CACHE_KEY = 'status_cache';
const STATUS_CACHE_TTL_MS = 3 * 60_000; // ~3 minutes

interface StatusCacheBlob {
  computedAt: number; // epoch ms when the scan ran
  smartWallets: number; // exact count from isSmartWallet (matches /api/smart-money/list)
  topSmart: Array<{
    rank: number;
    address: string;
    roiPct: number | null;
    pnlSol: number;
    winRate: number;
    trades: number;
    verified: boolean;
    seeded: boolean;
  }>;
}

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, error: 'Supabase not configured' }, { status: 503 });
  }

  const supabase = getSupabase();
  // INCLUSION uses the BROAD gate so the reported smart total matches the
  // broadened inventory surfaced everywhere else (leaderboard, live feed, …).
  const criteria = getBroadSmartCriteria();
  const now = Date.now();

  // Last cron runs (bookkeeping written by the indexer / refine passes), plus the
  // last_webhook_at ingest heartbeat written by the realtime webhook receiver.
  const { data: stateRows } = await supabase
    .from('indexer_state')
    .select('key, value, updated_at')
    .in('key', ['last_run', 'last_seed_run', 'last_webhook_at', 'last_link_tracking']);
  const state: Record<string, unknown> = {};
  for (const r of stateRows ?? []) state[(r as any).key] = (r as any).value;

  // INGEST HEALTH — surface whether webhooks/realtime are still flowing so the
  // operator (and UI) can tell at a glance if ingest died. Each is guarded so a
  // single failure leaves the field null instead of breaking the endpoint.

  // lastWebhookAt: the heartbeat the receiver stamps on every delivery.
  let lastWebhookAt: string | null = null;
  try {
    const raw = state.last_webhook_at;
    if (typeof raw === 'string') lastWebhookAt = raw;
    else if (raw && typeof raw === 'object') {
      const v =
        (raw as any).at ?? (raw as any).value ?? (raw as any).last_webhook_at ?? null;
      if (typeof v === 'string') lastWebhookAt = v;
    }
  } catch {
    lastWebhookAt = null;
  }

  // lastTradeAt: the newest trade we've ingested — a cheap indexed single-row read.
  let lastTradeAt: string | null = null;
  try {
    const { data: latestTrade } = await supabase
      .from('trades')
      .select('block_time')
      .order('block_time', { ascending: false })
      .limit(1)
      .maybeSingle();
    const bt = (latestTrade as any)?.block_time;
    if (bt != null) lastTradeAt = typeof bt === 'string' ? bt : new Date(bt).toISOString();
  } catch {
    lastTradeAt = null;
  }

  // Total indexed wallets.
  const { count: totalWallets } = await supabase
    .from('wallet_stats')
    .select('wallet', { count: 'exact', head: true });

  // Definitive verified count — and whether the migration is even applied.
  const vCount = await supabase
    .from('wallet_stats')
    .select('wallet', { count: 'exact', head: true })
    .eq('verified', true);
  const migrationApplied = !vCount.error;
  const verifiedWallets = vCount.error ? 0 : vCount.count ?? 0;

  // Compute how many wallets are "smart" at scale. This is the ONE field on this
  // endpoint that needs a full pass over the gate-passing set (the bot-filter /
  // maxWinRate nuance in isSmartWallet isn't expressible in SQL), so on a public,
  // frequently-hit status endpoint we serve a CACHED result and only re-scan at
  // most once every STATUS_CACHE_TTL_MS. The blob lives in indexer_state under
  // STATUS_CACHE_KEY. Any cache/DB error falls through to a fresh scan below.
  let smartWallets: number | null = null;
  let topSmart: StatusCacheBlob['topSmart'] | null = null;
  try {
    const { data: cacheRow } = await supabase
      .from('indexer_state')
      .select('value')
      .eq('key', STATUS_CACHE_KEY)
      .maybeSingle();
    const blob = (cacheRow as any)?.value as Partial<StatusCacheBlob> | undefined;
    if (
      blob &&
      typeof blob.computedAt === 'number' &&
      now - blob.computedAt < STATUS_CACHE_TTL_MS &&
      typeof blob.smartWallets === 'number' &&
      Array.isArray(blob.topSmart)
    ) {
      smartWallets = blob.smartWallets;
      topSmart = blob.topSmart;
    }
  } catch {
    // Cache read failed — fall through to a fresh scan.
    smartWallets = null;
    topSmart = null;
  }

  // Cache miss / stale / error → recompute. Push the CHEAP gate conditions into
  // the query so only plausible-smart rows come back — that set is small even as
  // the table grows. The remaining nuance (bot-filter, maxWinRate cap) is applied
  // in JS below so the final set is byte-identical to the gate.
  if (smartWallets == null || topSmart == null) {
    const cols =
      'wallet, score, realized_pnl, win_rate, consistency, total_trades, tokens_traded, last_trade_at';
    // Build a FRESH gate query per page (Supabase builders are single-use).
    const buildGate = () => {
      let qb = supabase
        .from('wallet_stats')
        .select(`${cols}, seeded, roi_pct, invested_sol, verified`)
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
    // PostgREST caps a single response at ~1000 rows, so .limit(20000) silently
    // clamps and the smart count pins at 1000 once it grows past that. Page through
    // with .range() to get the TRUE full gate-passing set.
    const extRead = await fetchAllRows(buildGate);

    // Degraded / pre-migration fallback: if the roi_pct/verified columns (or the
    // gate filters above) aren't available, fall back to the original top-N + JS.
    const rows: any[] | null = extRead.error
      ? (await supabase.from('wallet_stats').select(cols).order('score', { ascending: false }).range(0, 999)).data
      : extRead.data;

    const smart = (rows ?? []).filter((r: any) =>
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
    );

    smartWallets = smart.length;
    topSmart = smart.slice(0, 10).map((r: any, i: number) => ({
      rank: i + 1,
      address: r.wallet,
      roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
      pnlSol: Number(r.realized_pnl),
      winRate: Number(r.win_rate),
      trades: Number(r.total_trades),
      verified: Boolean(r.verified),
      seeded: Boolean(r.seeded),
    }));

    // Persist the derived numbers for the next ~3 min. Best-effort: a write
    // failure must not break the response (we already have the fresh values).
    try {
      const fresh: StatusCacheBlob = {
        computedAt: now,
        smartWallets,
        topSmart,
      };
      await supabase.from('indexer_state').upsert(
        { key: STATUS_CACHE_KEY, value: fresh, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    } catch {
      // ignore — caching is best-effort.
    }
  }

  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      lastIndexRun: state.last_run ?? null,
      lastRefineRun: state.last_seed_run ?? null,
      lastLinkRun: state.last_link_tracking ?? null,
      lastWebhookAt,
      lastTradeAt,
      migrationApplied,
      ...(migrationApplied
        ? {}
        : { action: 'Run supabase/schema.sql in the Supabase SQL editor — the roi_pct/verified columns are missing, so nothing can be marked verified/smart.' }),
      totals: {
        walletsIndexed: totalWallets ?? 0,
        smartWallets,
        verifiedWallets,
      },
      criteria,
      topSmart,
      links: {
        list: '/api/smart-money/list',
        listAddresses: '/api/smart-money/list?format=addresses',
        listCsv: '/api/smart-money/list?format=csv',
        leaderboard: '/smart-money',
        trackLinks: '/api/cron/track-links',
      },
    },
    // CDN-cache for pollers: the status endpoint is public and frequently hit by
    // monitors. force-dynamic still runs at origin, but s-maxage lets the Vercel
    // edge serve a cached copy for up to 60s instead of every poll hitting origin
    // (which does several DB reads). Body is unchanged.
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60' } }
  );
}
