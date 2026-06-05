/**
 * ON-DEMAND SMART-WALLET DISCOVERY
 *
 *   GET /api/smart-money/discover
 *
 * Scans recent coins live and returns the wallets that win across them — right
 * now, no cron, no database. Just needs HELIUS_API_KEY.
 *
 * Query params:
 *   ?coins=12        coins to scan (default 12, max 25)
 *   ?depth=300       transactions per coin (default 300, max 1000)
 *   ?min_coins=1     only wallets that won on at least this many coins
 *   ?min_pnl=0       only wallets with summed realized PnL >= this (SOL)
 *   ?limit=100       max wallets returned (default 100)
 *   ?format=json     json | addresses | csv
 *
 * Note: this takes ~30-60s because it reads live chain data per coin.
 */

import { NextRequest, NextResponse } from 'next/server';
import { discoverSmartWallets } from '../../../../lib/indexer/discover';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  if (!process.env.HELIUS_API_KEY) {
    return NextResponse.json(
      { error: 'HELIUS_API_KEY missing — cannot scan chain data' },
      { status: 503 }
    );
  }

  const { searchParams } = request.nextUrl;
  const coins = Math.min(Math.max(parseInt(searchParams.get('coins') || '12', 10) || 12, 1), 25);
  const depth = Math.min(Math.max(parseInt(searchParams.get('depth') || '300', 10) || 300, 100), 1000);
  const minCoins = Math.max(parseInt(searchParams.get('min_coins') || '1', 10) || 1, 0);
  const minPnl = Number(searchParams.get('min_pnl') ?? 0);
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '100', 10) || 100, 1), 500);
  const format = (searchParams.get('format') || 'json').toLowerCase();

  try {
    const result = await discoverSmartWallets({ maxCoins: coins, maxTxsPerCoin: depth });
    const wallets = result.wallets
      .filter((w) => w.coinsWon >= minCoins && w.realizedPnl >= minPnl)
      .slice(0, limit);

    if (format === 'addresses') {
      return new NextResponse(wallets.map((w) => w.wallet).join('\n') + '\n', {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="smart-wallets.txt"',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (format === 'csv') {
      const header = 'address,realized_pnl_sol,unrealized_pnl_sol,total_pnl_sol,coins_traded,coins_won,buys,sells';
      const lines = wallets.map((w) =>
        [w.wallet, w.realizedPnl, w.unrealizedPnl, w.totalPnl, w.coinsTraded, w.coinsWon, w.buys, w.sells]
          .map(csvEscape)
          .join(',')
      );
      return new NextResponse([header, ...lines].join('\n') + '\n', {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="smart-wallets.csv"',
          'Cache-Control': 'no-store',
        },
      });
    }

    return NextResponse.json(
      {
        coinsScanned: result.coinsScanned,
        walletCount: result.walletCount,
        returned: wallets.length,
        elapsedMs: result.elapsedMs,
        filters: { minCoins, minPnl, coins, depth },
        wallets,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[DISCOVER] failed:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
