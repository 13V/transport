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

export const dynamic = 'force-dynamic';

interface SmartWalletRow {
  address: string;
  score: number;
  pnl: number;
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

  const supabase = getSupabase();

  // Pull the top-ranked wallets with every field curation needs. Over-fetch so
  // that after filtering we can still return up to `limit` smart wallets.
  const baseCols =
    'wallet, score, realized_pnl, win_rate, consistency, total_trades, tokens_traded, last_trade_at';
  const seededRead = await supabase
    .from('wallet_stats')
    .select(`${baseCols}, seeded`)
    .order('score', { ascending: false })
    .limit(2000);

  const { data, error }: { data: any[] | null; error: { message: string } | null } =
    seededRead.error
      ? await supabase
          .from('wallet_stats')
          .select(baseCols)
          .order('score', { ascending: false })
          .limit(2000)
      : seededRead;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const criteria = getSmartCriteria();
  const now = Date.now();

  const wallets: SmartWalletRow[] = (data ?? [])
    .filter((r: any) =>
      isSmartWallet(
        {
          realizedPnl: Number(r.realized_pnl),
          winRate: Number(r.win_rate),
          totalTrades: Number(r.total_trades),
          tokensTraded: Number(r.tokens_traded),
          score: Number(r.score),
          lastTradeAt: r.last_trade_at,
          seeded: Boolean(r.seeded),
        },
        criteria,
        now
      )
    )
    .slice(0, limit)
    .map((r: any) => ({
      address: r.wallet,
      score: Number(r.score),
      pnl: Number(r.realized_pnl),
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
    const header = 'address,score,pnl_sol,win_rate,consistency,total_trades,tokens_traded,last_trade_at';
    const lines = wallets.map((w) =>
      [
        w.address,
        w.score,
        w.pnl,
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
