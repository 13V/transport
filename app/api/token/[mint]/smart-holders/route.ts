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
import { getBroadSmartCriteria, isSmartWallet } from '../../../../../lib/indexer/curation';
import { tierFromScore } from '../../../../../lib/format';
import { getTokenMeta } from '../../../../../lib/token-meta';
import { fetchTokenPricesSol } from '../../../../../lib/prices/price-oracle';

export const revalidate = 30;
export const maxDuration = 30;

const MAX_TRADE_ROWS = 6000;

interface SmartHolder {
  wallet: string;
  tier: string | null;
  allTimeRoiPct: number | null;
  verified: boolean;
  solBought: number;
  avgCostSol: number;      // average entry price per token on this coin (SOL/token)
  pnlOnThisCoin: number;   // average-cost realized PnL on this coin (SOL), clamped to matched qty
  unrealizedSol: number;   // remaining bag marked to live price (SOL)
  currentValueSol: number; // remaining bag value at live price (SOL)
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
    return NextResponse.json(
      { error: 'Invalid mint address' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const headers = { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' };

  // Token identity (logo / ticker / name) for the page header — resolved once,
  // included in every response so the title shows even with zero smart holders.
  let token: { symbol?: string; name?: string; icon?: string; icons?: string[] } | undefined;
  try { token = (await getTokenMeta([mint])).get(mint); } catch { /* ignore */ }

  const empty = { mint, token, traderCount: 0, smartHolderCount: 0, smartHolders: [] as SmartHolder[], netFlowSeries: [] as number[] };
  if (!isSupabaseConfigured()) return NextResponse.json(empty, { headers });

  try {
    const supabase = getSupabase();
    // INCLUSION uses the BROAD gate so the smart-holders list matches the buying feed.
    const criteria = getBroadSmartCriteria();
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

    // 2. Pull every ingested trade on this coin, then intersect with the
    // smart-wallet set IN MEMORY.
    //
    // Previously this looped the smart-wallet set in 200-chunks, issuing one
    // mint-scoped `.in('wallet', chunk)` query per chunk — but every chunk hit
    // the SAME small per-mint partition (trades for one token), so we re-scanned
    // it N times for a single coin. A coin's full trade history is small and
    // already covered by the trades(token_mint, block_time) index, so ONE
    // mint-scoped query (capped) is strictly cheaper: ~5 queries -> 1.
    const smartSet = new Set(smartWallets);
    const read = await supabase
      .from('trades')
      .select('wallet, trade_type, amount, price, block_time')
      .eq('token_mint', mint)
      .order('block_time', { ascending: true })
      .limit(MAX_TRADE_ROWS);
    if (read.error) return NextResponse.json(empty, { headers });
    const rows: any[] = (read.data ?? []).filter((r: any) => smartSet.has(String(r.wallet)));

    // 3. Aggregate per wallet → average-cost realized PnL on this coin.
    interface Agg {
      solSpent: number; tokensBought: number; solReceived: number; tokensSold: number;
      buys: number; sells: number; lastBuy: number | null;
    }
    const byWallet = new Map<string, Agg>();
    // Net smart-money flow: signed SOL per hour bucket (buys +, sells −), to be
    // turned into a cumulative series for the page chart.
    const flowByHour = new Map<number, number>();
    const HOUR_MS = 3600_000;
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
      if (Number.isFinite(ts) && sol > 0) {
        const bucket = Math.floor(ts / HOUR_MS) * HOUR_MS;
        flowByHour.set(bucket, (flowByHour.get(bucket) ?? 0) + (isBuy ? sol : -sol));
      }
    }

    // Cumulative signed-SOL series, ordered oldest → newest, filling empty hours
    // so the curve is time-proportional (matches the Dashboard cumulative pattern).
    let netFlowSeries: number[] = [];
    if (flowByHour.size > 0) {
      const buckets = Array.from(flowByHour.keys()).sort((x, y) => x - y);
      const r4flow = (n: number) => Math.round(n * 1e4) / 1e4;
      let acc = 0;
      for (let b = buckets[0]; b <= buckets[buckets.length - 1]; b += HOUR_MS) {
        acc += flowByHour.get(b) ?? 0;
        netFlowSeries.push(r4flow(acc));
      }
      // Cap the series length — long-lived coins can accumulate thousands of
      // hourly points. This is a purely visual cumulative curve, so we downsample
      // (always keeping the final point, the load-bearing net value) to bound the
      // payload and the SVG smooth-path cost on this, the heaviest page.
      const MAX_FLOW_POINTS = 240;
      if (netFlowSeries.length > MAX_FLOW_POINTS) {
        const step = netFlowSeries.length / MAX_FLOW_POINTS;
        const sampled: number[] = [];
        for (let i = 0; i < MAX_FLOW_POINTS; i++) sampled.push(netFlowSeries[Math.floor(i * step)]);
        sampled[sampled.length - 1] = netFlowSeries[netFlowSeries.length - 1];
        netFlowSeries = sampled;
      }
    }

    // Live SOL price for the coin (proven oracle; SOL per UI-token, same unit as
    // our trade `amount`). Used to mark each holder's remaining bag to market.
    let priceSol = 0;
    try { priceSol = (await fetchTokenPricesSol([mint])).get(mint) ?? 0; } catch { /* no live price */ }

    const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
    const holders: SmartHolder[] = Array.from(byWallet.entries()).map(([wallet, a]) => {
      const avgCost = a.tokensBought > 0 ? a.solSpent / a.tokensBought : 0;
      // Clamp realized PnL to the quantity we actually have a cost basis for —
      // unbacked sells (bought before our trade window) would invent phantom
      // profit at cost-basis 0. Mirrors lib/indexer/token-traders.ts.
      const avgSell = a.tokensSold > 0 ? a.solReceived / a.tokensSold : 0;
      const matchedSold = Math.min(a.tokensSold, a.tokensBought);
      const realized = matchedSold * (avgSell - avgCost); // 0 for pure holders
      const tokensRemaining = Math.max(0, a.tokensBought - a.tokensSold);
      const currentValueSol = priceSol > 0 ? tokensRemaining * priceSol : 0;
      const unrealizedSol = priceSol > 0 ? tokensRemaining * (priceSol - avgCost) : 0;
      const m = meta.get(wallet);
      return {
        wallet,
        tier: m?.tier ?? null,
        allTimeRoiPct: m?.roi ?? null,
        verified: true,
        solBought: r4(a.solSpent),
        avgCostSol: r4(avgCost),
        pnlOnThisCoin: r4(realized),
        unrealizedSol: r4(unrealizedSol),
        currentValueSol: r4(currentValueSol),
        tokensRemaining,
        buys: a.buys,
        sells: a.sells,
        lastBuy: a.lastBuy == null ? null : new Date(a.lastBuy).toISOString(),
      };
    }).sort((x, y) => (y.currentValueSol || y.solBought) - (x.currentValueSol || x.solBought));

    return NextResponse.json(
      { mint, token, priceSol, traderCount: holders.length, smartHolderCount: holders.length, smartHolders: holders, netFlowSeries },
      { headers }
    );
  } catch {
    return NextResponse.json(empty, { headers });
  }
}
