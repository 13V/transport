/**
 * SMART-WALLET LIST EXPORT
 *
 * The product surface: a curated list of smart wallets users can drop straight
 * into a trading terminal watchlist or a Telegram alert bot.
 *
 *   GET /api/smart-money/list                 → JSON { count, total, criteria, wallets[] }
 *   GET /api/smart-money/list?format=addresses → text/plain, one address per line
 *   GET /api/smart-money/list?format=csv       → CSV with stats
 *   GET /api/smart-money/list?limit=100        → cap the result (default 200, max 1000)
 *   GET /api/smart-money/list?page=2&pageSize=25 → server-side page (1-based);
 *       returns just that page plus `total` (the full filtered+gated count) so a
 *       client can render a pager without pulling the whole set.
 *
 * Sorting is server-side: ?sort=roi | pnl | score | recent (default score).
 *
 * Only wallets that clear the smart-money quality gate (lib/indexer/curation.ts)
 * are returned. Read-only and public — safe to poll from an alert bot.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { getSmartCriteria, isSmartWallet } from '../../../../lib/indexer/curation';
import { tierFromScore } from '../../../../lib/format';

export const revalidate = 60;

const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
};

interface SmartWalletRow {
  address: string;
  score: number;
  tier: string | null;
  pnl: number;
  roiPct: number | null;
  investedSol: number | null;
  verified: boolean;
  winRate: number;
  consistency: number;
  totalTrades: number;
  tokensTraded: number;
  lastTradeAt: string | null;
  seeded: boolean;
}

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase not configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const { searchParams } = request.nextUrl;
  const format = (searchParams.get('format') || 'json').toLowerCase();
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '200', 10) || 200, 1), 1000);
  // Default to accurate, deep-scanned wallets only — these have a trustworthy
  // all-time ROI. Pass ?verified=0 to include token-first discoveries too.
  const verifiedOnly = searchParams.get('verified') !== '0';
  // Server-side sort. `roi` keeps the historic alias; `score` is the default.
  const sortRaw = (searchParams.get('sort') || '').toLowerCase();
  const sortKey: 'roi' | 'pnl' | 'score' | 'recent' | 'winrate' =
    sortRaw === 'roi' || sortRaw === 'pnl' || sortRaw === 'recent' || sortRaw === 'winrate'
      ? sortRaw
      : 'score';
  // Sort direction. Defaults to descending (the historic behaviour for every
  // metric); `asc` flips it. Applied after the metric comparator below.
  const sortDir = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  // Optional server-side pagination. Detected by the presence of `page` (or
  // `pageSize`). When absent we keep the legacy behaviour: cap at `limit` and
  // return every matching row up to that cap (Dashboard's ?sort=roi&limit=8,
  // WatchlistView's ?limit=1000, and the addresses/csv exports all rely on it).
  const hasPaging = searchParams.has('page') || searchParams.has('pageSize');
  const page = Math.max(parseInt(searchParams.get('page') || '1', 10) || 1, 1);
  const pageSize = Math.min(
    Math.max(parseInt(searchParams.get('pageSize') || '25', 10) || 25, 1),
    100
  );
  // ?gate=0 returns the verified wallets WITHOUT the smart-money filter, so the
  // raw ROI/PnL numbers can be inspected and the thresholds calibrated.
  const applyGate = searchParams.get('gate') !== '0';
  // Optional, backward-compatible refinements pushed into the query so the
  // leaderboard's filters stay correct across the full set, not just a page.
  const q = (searchParams.get('q') || '').trim().toLowerCase();
  const minPnlRaw = searchParams.get('minPnl');
  const minPnl = minPnlRaw != null && minPnlRaw !== '' ? Number(minPnlRaw) : null;
  const activeDaysRaw = searchParams.get('activeDays');
  const activeDays =
    activeDaysRaw != null && activeDaysRaw !== '' ? Number(activeDaysRaw) : null;
  // Leaderboard toolbar filters, applied server-side so they're correct across
  // the whole set rather than just a client page.
  const minRoiRaw = searchParams.get('minRoi');
  const minRoi = minRoiRaw != null && minRoiRaw !== '' ? Number(minRoiRaw) : null;
  const tierRaw = (searchParams.get('tier') || '').toUpperCase();
  const tierFilter = ['S', 'A', 'B', 'C'].includes(tierRaw) ? tierRaw : null;

  const supabase = getSupabase();
  const criteria = getSmartCriteria();
  const now = Date.now();

  // Pull the top-ranked wallets with every field curation needs. To keep the
  // curated list correct as the verified set grows past a fixed top-N, push the
  // CHEAP gate conditions into the query (when the gate is on) so only
  // plausible-smart rows are fetched; the bot-filter/maxWinRate nuance is still
  // applied in JS below so the final set matches the gate exactly.
  const baseCols =
    'wallet, score, realized_pnl, win_rate, consistency, total_trades, tokens_traded, last_trade_at';
  const extCols = `${baseCols}, seeded, roi_pct, invested_sol, verified`;
  let extQuery = supabase.from('wallet_stats').select(extCols);
  // Optional refinements — applied independently of the smart-money gate so the
  // leaderboard's search / min-PnL / active-within filters work across the full
  // set rather than only the first client-side page.
  if (q) {
    extQuery = extQuery.ilike('wallet', `${q}%`);
  }
  if (minPnl != null && Number.isFinite(minPnl)) {
    extQuery = extQuery.gte('realized_pnl', minPnl);
  }
  if (minRoi != null && Number.isFinite(minRoi)) {
    extQuery = extQuery.gte('roi_pct', minRoi);
  }
  if (activeDays != null && Number.isFinite(activeDays) && activeDays > 0) {
    const cutoff = new Date(now - activeDays * 86_400_000).toISOString();
    extQuery = extQuery.gte('last_trade_at', cutoff);
  }
  if (applyGate) {
    extQuery = extQuery
      .not('roi_pct', 'is', null)
      .gte('roi_pct', criteria.minRoiPct)
      .gte('realized_pnl', criteria.minPnlSol)
      .gte('total_trades', criteria.minTrades)
      .gte('tokens_traded', criteria.minTokens);
    if (criteria.minInvestedSol > 0) {
      extQuery = extQuery.gte('invested_sol', criteria.minInvestedSol);
    }
    if (criteria.maxIdleDays > 0) {
      const cutoff = new Date(now - criteria.maxIdleDays * 86_400_000).toISOString();
      extQuery = extQuery.gte('last_trade_at', cutoff);
    }
  }
  const extRead = await extQuery.order('score', { ascending: false }).limit(20000);

  // Degraded / pre-migration fallback: if the accurate columns (or gate filters)
  // aren't available, fall back to the original top-N fetch over base columns.
  const { data, error }: { data: any[] | null; error: { message: string } | null } =
    extRead.error
      ? await supabase
          .from('wallet_stats')
          .select(baseCols)
          .order('score', { ascending: false })
          .limit(2000)
      : extRead;

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const hasVerifiedCol = !extRead.error;

  // The smart-money gate finishes in JS (the bot-filter, maxWinRate cap and the
  // verified-only restriction aren't all expressible in the query), so we apply
  // it here to get the exact, correct full set. We then sort and paginate that
  // set on the SERVER and ship only the requested slice — the browser no longer
  // pulls 20k rows. `total` is the size of this fully-filtered, sorted set.
  const filtered = (data ?? []).filter((r: any) => {
    // When the accurate columns exist and verified-only is on, restrict to
    // deep-scanned wallets so the displayed ROI is trustworthy.
    if (verifiedOnly && hasVerifiedCol && !r.verified) return false;
    // Tier filter maps score → tier band (same mapping returned to the client).
    if (tierFilter && tierFromScore(Number(r.score)) !== tierFilter) return false;
    if (!applyGate) return true;
    return isSmartWallet(
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
  });

  // Descending comparator per metric; `dir=asc` flips the final result.
  const flip = sortDir === 'asc' ? -1 : 1;
  filtered.sort((a: any, b: any) => {
    let d: number;
    switch (sortKey) {
      case 'roi':
        d = Number(b.roi_pct ?? -1e9) - Number(a.roi_pct ?? -1e9);
        break;
      case 'pnl':
        d = Number(b.realized_pnl) - Number(a.realized_pnl);
        break;
      case 'winrate':
        d = Number(b.win_rate) - Number(a.win_rate);
        break;
      case 'recent':
        d =
          (b.last_trade_at ? Date.parse(b.last_trade_at) : -1) -
          (a.last_trade_at ? Date.parse(a.last_trade_at) : -1);
        break;
      default:
        d = Number(b.score) - Number(a.score);
    }
    return d * flip;
  });

  // `total` reflects the whole filtered+gated set, regardless of paging mode.
  const total = filtered.length;

  // Paged mode: slice out the requested 1-based page. Legacy mode: cap at limit.
  const pageRows = hasPaging
    ? filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
    : filtered.slice(0, limit);

  const wallets: SmartWalletRow[] = pageRows.map((r: any) => ({
    address: r.wallet,
    score: Number(r.score),
    tier: tierFromScore(Number(r.score)),
    pnl: Number(r.realized_pnl),
    roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
    investedSol: r.invested_sol == null ? null : Number(r.invested_sol),
    verified: Boolean(r.verified),
    winRate: Number(r.win_rate),
    consistency: Number(r.consistency),
    totalTrades: Number(r.total_trades),
    tokensTraded: Number(r.tokens_traded),
    lastTradeAt: r.last_trade_at ?? null,
    seeded: Boolean(r.seeded),
  }));

  if (format === 'addresses') {
    return new NextResponse(wallets.map((w) => w.address).join('\n') + '\n', {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="smart-wallets.txt"',
        ...CACHE_HEADERS,
      },
    });
  }

  if (format === 'csv') {
    const header =
      'address,roi_pct,realized_pnl_sol,invested_sol,verified,score,win_rate,consistency,total_trades,tokens_traded,last_trade_at';
    const lines = wallets.map((w) =>
      [
        w.address,
        w.roiPct ?? '',
        w.pnl,
        w.investedSol ?? '',
        w.verified,
        w.score,
        w.winRate,
        w.consistency,
        w.totalTrades,
        w.tokensTraded,
        w.lastTradeAt ?? '',
      ]
        .map(csvEscape)
        .join(',')
    );
    return new NextResponse([header, ...lines].join('\n') + '\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="smart-wallets.csv"',
        ...CACHE_HEADERS,
      },
    });
  }

  return NextResponse.json(
    {
      count: wallets.length,
      // Full size of the filtered+gated set, so a client can render a pager
      // without pulling every row. In legacy (un-paged) mode it's the same set
      // the `wallets` array is capped from.
      total,
      page: hasPaging ? page : 1,
      pageSize: hasPaging ? pageSize : wallets.length,
      criteria,
      generatedAt: new Date().toISOString(),
      wallets,
    },
    { headers: CACHE_HEADERS }
  );
}
