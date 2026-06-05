/**
 * WALLET PROFILE (rich view)
 *
 *   GET /api/wallet/{address}/profile
 *
 * One-shot detail view for a single wallet. Stitches together the cached
 * leaderboard stats, a per-token PnL breakdown (best & worst trades replayed
 * through the accurate FIFO engine), the most recent activity, and the funding
 * cluster around the wallet.
 *
 * Resilient by design: if the wallet_stats row (or some of its columns) is
 * missing we still return the per-token breakdown, recent trades, and cluster
 * so the page degrades gracefully instead of 500-ing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../../lib/supabase-client';
import { computeAccuratePnL } from '../../../../../lib/indexer/accurate-pnl';
import type { Trade } from '../../../../../lib/pnl-engine';

export const dynamic = 'force-dynamic';

const TRADE_SCAN_LIMIT = 5000;

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Map a raw trades-row source string onto the Trade union, defaulting safely. */
function mapSource(raw: any): Trade['source'] {
  switch (String(raw ?? '').toUpperCase()) {
    case 'BONDING_CURVE':
      return 'BONDING_CURVE';
    case 'RAYDIUM':
      return 'RAYDIUM';
    case 'ORCA':
      return 'ORCA';
    case 'JUPITER':
      return 'JUPITER';
    default:
      return 'RAYDIUM';
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;

  // Base58-ish sanity check — Solana addresses are 32..44 chars.
  if (
    !address ||
    address.length < 32 ||
    address.length > 44 ||
    !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)
  ) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }

  const supabase = getSupabase();

  // Fetch everything in parallel. Each query is independently tolerant of
  // errors so a missing table/column never sinks the whole response.
  const [statsRes, tradesRes, recentRes, fundedRes, fundedByRes] = await Promise.all([
    supabase.from('wallet_stats').select('*').eq('wallet', address).maybeSingle(),
    supabase
      .from('trades')
      .select('token_mint, trade_type, amount, price, source, tx_hash, block_time')
      .eq('wallet', address)
      .order('block_time', { ascending: true })
      .limit(TRADE_SCAN_LIMIT),
    supabase
      .from('trades')
      .select('token_mint, trade_type, amount, price, source, tx_hash, block_time')
      .eq('wallet', address)
      .order('block_time', { ascending: false })
      .limit(20),
    supabase
      .from('wallet_links')
      .select('target, amount_sol, transfers, last_seen')
      .eq('source', address)
      .order('amount_sol', { ascending: false })
      .limit(20),
    supabase
      .from('wallet_links')
      .select('source, amount_sol, transfers, last_seen')
      .eq('target', address)
      .order('amount_sol', { ascending: false })
      .limit(20),
  ]);

  // ---- stats (camelCase, null when no row) -------------------------------
  const sr: any = statsRes?.data ?? null;
  const stats = sr
    ? {
        score: sr.score ?? null,
        roiPct: sr.roi_pct != null ? Number(sr.roi_pct) : null,
        realizedPnl: sr.realized_pnl != null ? Number(sr.realized_pnl) : null,
        investedSol: sr.invested_sol != null ? Number(sr.invested_sol) : null,
        winRate: sr.win_rate != null ? Number(sr.win_rate) : null,
        consistency: sr.consistency != null ? Number(sr.consistency) : null,
        totalTrades: sr.total_trades ?? null,
        tokensTraded: sr.tokens_traded ?? null,
        verified: sr.verified ?? null,
        seeded: sr.seeded ?? null,
        fundedBy: sr.funded_by ?? null,
        lastTradeAt: sr.last_trade_at ?? null,
      }
    : null;

  // ---- per-token PnL breakdown -------------------------------------------
  const rawTrades: any[] = tradesRes?.error ? [] : tradesRes?.data ?? [];
  const allTrades: Trade[] = rawTrades.map((r) => ({
    tokenMint: r.token_mint,
    tradeType: r.trade_type === 'SELL' ? 'SELL' : 'BUY',
    amount: Number(r.amount),
    pricePerToken: Number(r.price),
    date: new Date(r.block_time),
    txHash: r.tx_hash,
    source: mapSource(r.source),
  }));

  const byToken = new Map<string, Trade[]>();
  for (const t of allTrades) {
    const arr = byToken.get(t.tokenMint);
    if (arr) arr.push(t);
    else byToken.set(t.tokenMint, [t]);
  }

  const tokenPnls = Array.from(byToken.entries()).map(([mint, trades]) => {
    const pnl = computeAccuratePnL(trades);
    return {
      mint,
      realizedPnlSol: pnl.realizedPnlSol,
      roiPct: pnl.roiPct,
      trades: trades.length,
    };
  });

  const sortedDesc = [...tokenPnls].sort((a, b) => b.realizedPnlSol - a.realizedPnlSol);
  const best = sortedDesc.slice(0, 10);
  const worst = [...tokenPnls]
    .sort((a, b) => a.realizedPnlSol - b.realizedPnlSol)
    .slice(0, 10);

  // ---- recent trades ------------------------------------------------------
  const rawRecent: any[] = recentRes?.error ? [] : recentRes?.data ?? [];
  const recentTrades = rawRecent.map((r) => ({
    mint: r.token_mint,
    type: r.trade_type === 'SELL' ? 'SELL' : 'BUY',
    amountSol: round4(Number(r.amount) * Number(r.price)),
    source: r.source,
    txHash: r.tx_hash,
    at: r.block_time,
  }));

  // ---- funding cluster ----------------------------------------------------
  const fundedRows: any[] = fundedRes?.error ? [] : fundedRes?.data ?? [];
  const fundedByRows: any[] = fundedByRes?.error ? [] : fundedByRes?.data ?? [];
  const cluster = {
    funded: fundedRows.map((r) => ({
      wallet: r.target,
      amountSol: Number(r.amount_sol),
      transfers: r.transfers,
      lastSeen: r.last_seen,
    })),
    fundedBy: fundedByRows.map((r) => ({
      wallet: r.source,
      amountSol: Number(r.amount_sol),
      transfers: r.transfers,
      lastSeen: r.last_seen,
    })),
  };

  return NextResponse.json(
    {
      address,
      stats,
      perToken: { best, worst },
      recentTrades,
      cluster,
    },
    { headers: { 'Cache-Control': 'public, max-age=120' } }
  );
}
