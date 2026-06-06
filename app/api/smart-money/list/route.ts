/**
 * SMART-WALLET LIST EXPORT
 *
 * The product surface: a curated list of smart wallets users can drop straight
 * into a trading terminal watchlist or a Telegram alert bot.
 *
 *   GET /api/smart-money/list                 → JSON { count, criteria, wallets[] }
 *   GET /api/smart-money/list?format=addresses → text/plain, one address per line
 *   GET /api/smart-money/list?format=csv       → CSV with stats
 *   GET /api/smart-money/list?limit=100        → cap the result (default 200, max 1000)
 *
 * Only wallets that clear the smart-money quality gate (lib/indexer/curation.ts)
 * are returned. Read-only and public — safe to poll from an alert bot.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { getSmartCriteria, isSmartWallet } from '../../../../lib/indexer/curation';
import { tierFromScore } from '../../../../lib/format';

export const dynamic = 'force-dynamic';

interface SmartWalletRow {
  address: string;
  score: number;
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
      { status: 503 }
    );
  }

  const { searchParams } = request.nextUrl;
  const format = (searchParams.get('format') || 'json').toLowerCase();
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '200', 10) || 200, 1), 1000);
  // Default to accurate, deep-scanned wallets only — these have a trustworthy
  // all-time ROI. Pass ?verified=0 to include token-first discoveries too.
  const verifiedOnly = searchParams.get('verified') !== '0';
  const sortByRoi = searchParams.get('sort') === 'roi';
  // ?gate=0 returns the verified wallets WITHOUT the smart-money filter, so the
  // raw ROI/PnL numbers can be inspected and the thresholds calibrated.
  const applyGate = searchParams.get('gate') !== '0';

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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const hasVerifiedCol = !extRead.error;

  const wallets: SmartWalletRow[] = (data ?? [])
    .filter((r: any) => {
      // When the accurate columns exist and verified-only is on, restrict to
      // deep-scanned wallets so the displayed ROI is trustworthy.
      if (verifiedOnly && hasVerifiedCol && !r.verified) return false;
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
    })
    .sort((a: any, b: any) =>
      sortByRoi ? Number(b.roi_pct ?? -1e9) - Number(a.roi_pct ?? -1e9) : Number(b.score) - Number(a.score)
    )
    .slice(0, limit)
    .map((r: any) => ({
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
        'Cache-Control': 'public, max-age=300',
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
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  return NextResponse.json(
    {
      count: wallets.length,
      criteria,
      generatedAt: new Date().toISOString(),
      wallets,
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } }
  );
}
