/**
 * SMART MONEY IN A COIN
 *
 *   GET /api/token/{mint}/smart-holders
 *
 * Which proven smart wallets are in this coin, and how are they doing on it?
 *
 * IMPORTANT: this reads the SAME source as the buying feed (the ingested
 * `trades` table intersected with the verified smart-money set) so the two are
 * always consistent — if /api/smart-money/buying says N smart wallets bought a
 * token, this lists those same wallets. (The old version did a shallow live
 * Helius scan that missed already-ingested trades, so a coin could show smart
 * buyers on the dashboard yet "no smart money" here.)
 *
 * Per holder we pair the wallet's all-time track record (wallet_stats.roi_pct /
 * score → tier) with its activity on THIS coin (SOL bought, average-cost
 * realized PnL, current position, last buy) from the ingested trades.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../../lib/supabase-client';
import { getSmartCriteria, isSmartWallet } from '../../../../../lib/indexer/curation';
import { tierFromScore } from '../../../../../lib/format';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const WALLET_CHUNK = 200;
const MAX_TRADE_ROWS = 6000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface SmartHolder {
  wallet: string;
  tier: string | null;
  allTimeRoiPct: number | null;
  verified: boolean;
  solBought: number;
  pnlOnThisCoin: number; // average-cost realized PnL on this coin (SOL)
  tokensRemaining: number;
  buys: number;
  sells: number;
  lastBuy: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mint: string }> }
) {
  const { mint } = await params;
  if (!mint || mint.length < 32 || mint.length > 64) {
    return NextResponse.json({ error: 'Invalid mint address' }, { status: 400 });
  }

  const empty = { mint, traderCount: 0, smartHolderCount: 0, smartHolders: [] as SmartHolder[] };
  const headers = { 'Cache-Control': 'public, max-age=60' };
  if (!isSupabaseConfigured()) return NextResponse.json(empty, { headers });

  try {
    const supabase = getSupabase();
    const criteria = getSmartCriteria();
    const now = Date.now();

    // 1. Resolve the smart-wallet set — identical definition to the buying feed.
    const statRead = await supabase
      .from('wallet_stats')
      .select('wallet, score, realized_pnl, roi_pct, invested_sol, win_rate, total_trades, tokens_traded, last_trade_at, seeded')
      .eq('verified', true);
    if (statRead.error || !statRead.data) return NextResponse.json(empty, { headers });

    const meta = new Map<string, { roi: number | null; tier: string | null }>();
    const smartWallets: string[] = [];
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
      const w = String(r.wallet);
      smartWallets.push(w);
      meta.set(w, {
        roi: r.roi_pct == null ? null : Number(r.roi_pct),
        tier: tierFromScore(r.score == null ? null : Number(r.score)),
      });
    }
    if (smartWallets.length === 0) return NextResponse.json(empty, { headers });

    // 2. Pull every ingested trade on this coin by those wallets.
    const rows: any[] = [];
    for (const group of chunk(smartWallets, WALLET_CHUNK)) {
      if (rows.length >= MAX_TRADE_ROWS) break;
      const read = await supabase
        .from('trades')
        .select('wallet, trade_type, amount, price, block_time')
        .eq('token_mint', mint)
        .in('wallet', group)
        .order('block_time', { ascending: true })
        .limit(MAX_TRADE_ROWS - rows.length);
      if (read.error) return NextResponse.json(empty, { headers });
      if (read.data) rows.push(...read.data);
    }

    // 3. Aggregate per wallet → average-cost realized PnL on this coin.
    interface Agg {
      solSpent: number; tokensBought: number; solReceived: number; tokensSold: number;
      buys: number; sells: number; lastBuy: number | null;
    }
    const byWallet = new Map<string, Agg>();
    for (const t of rows) {
      const w = String(t.wallet);
      const amount = Number(t.amount);
      const price = Number(t.price);
      const sol = Number.isFinite(amount) && Number.isFinite(price) ? amount * price : 0;
      const isBuy = String(t.trade_type).toUpperCase() === 'BUY';
      const ts = t.block_time ? new Date(t.block_time).getTime() : NaN;
      let a = byWallet.get(w);
      if (!a) { a = { solSpent: 0, tokensBought: 0, solReceived: 0, tokensSold: 0, buys: 0, sells: 0, lastBuy: null }; byWallet.set(w, a); }
      if (isBuy) {
        a.buys += 1; a.solSpent += sol; a.tokensBought += Number.isFinite(amount) ? amount : 0;
        if (Number.isFinite(ts) && (a.lastBuy == null || ts > a.lastBuy)) a.lastBuy = ts;
      } else {
        a.sells += 1; a.solReceived += sol; a.tokensSold += Number.isFinite(amount) ? amount : 0;
      }
    }

    const holders: SmartHolder[] = Array.from(byWallet.entries()).map(([wallet, a]) => {
      const avgCost = a.tokensBought > 0 ? a.solSpent / a.tokensBought : 0;
      const realized = a.solReceived - avgCost * a.tokensSold; // 0 for pure holders
      const m = meta.get(wallet);
      return {
        wallet,
        tier: m?.tier ?? null,
        allTimeRoiPct: m?.roi ?? null,
        verified: true,
        solBought: Math.round(a.solSpent * 1e4) / 1e4,
        pnlOnThisCoin: Math.round(realized * 1e4) / 1e4,
        tokensRemaining: Math.max(0, a.tokensBought - a.tokensSold),
        buys: a.buys,
        sells: a.sells,
        lastBuy: a.lastBuy == null ? null : new Date(a.lastBuy).toISOString(),
      };
    }).sort((x, y) => y.solBought - x.solBought);

    return NextResponse.json(
      { mint, traderCount: holders.length, smartHolderCount: holders.length, smartHolders: holders },
      { headers }
    );
  } catch {
    return NextResponse.json(empty, { headers });
  }
}
