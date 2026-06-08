/**
 * WALLET HOLDINGS (unrealized view)
 *
 *   GET /api/wallet/{address}/holdings
 *
 * "What is this wallet still holding right now, and is it up?" — the
 * complement to realized ROI. We replay the wallet's trades to find tokens
 * with a positive net balance (more bought than sold), then mark them to
 * market against live SOL-denominated prices from the price oracle.
 *
 * Per held token we report current value, average cost basis, and the
 * unrealized PnL implied by the current price. Tokens fully sold (or net
 * zero/negative) are excluded.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../../lib/supabase-client';
import { fetchTokenPricesSol } from '../../../../../lib/prices/price-oracle';

export const dynamic = 'force-dynamic';

const TRADE_SCAN_LIMIT = 5000;

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

interface TokenAgg {
  bought: number; // total tokens bought
  sold: number; // total tokens sold
  solSpent: number; // SOL paid on buys
  solReceived: number; // SOL received on sells
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

  const tradesRes = await supabase
    .from('trades')
    .select('token_mint, trade_type, amount, price, block_time')
    .eq('wallet', address)
    .order('block_time', { ascending: true })
    .limit(TRADE_SCAN_LIMIT);

  const rawTrades: any[] = tradesRes?.error ? [] : tradesRes?.data ?? [];

  // Aggregate per token: net balance and SOL flows.
  const byToken = new Map<string, TokenAgg>();
  for (const r of rawTrades) {
    const mint: string = r.token_mint;
    if (!mint) continue;
    const amount = Number(r.amount);
    const price = Number(r.price);
    if (!Number.isFinite(amount)) continue;
    const sol = Number.isFinite(price) ? amount * price : 0;

    let agg = byToken.get(mint);
    if (!agg) {
      agg = { bought: 0, sold: 0, solSpent: 0, solReceived: 0 };
      byToken.set(mint, agg);
    }
    if (r.trade_type === 'SELL') {
      agg.sold += amount;
      agg.solReceived += sol;
    } else {
      agg.bought += amount;
      agg.solSpent += sol;
    }
  }

  // Keep only tokens still held (positive net balance).
  const held: { mint: string; netTokens: number; agg: TokenAgg }[] = [];
  for (const [mint, agg] of byToken) {
    const netTokens = agg.bought - agg.sold;
    if (netTokens > 0) held.push({ mint, netTokens, agg });
  }

  // Mark to market against live SOL prices.
  const prices = await fetchTokenPricesSol(held.map((h) => h.mint));

  const holdings = held.map(({ mint, netTokens, agg }) => {
    const priceSol = prices.get(mint) ?? 0;
    const avgCost = agg.bought > 0 ? agg.solSpent / agg.bought : 0;
    const currentValueSol = netTokens * priceSol;
    const unrealizedSol = netTokens * (priceSol - avgCost);
    return {
      mint,
      tokens: round4(netTokens),
      currentValueSol: round4(currentValueSol),
      avgCostSol: round4(avgCost),
      unrealizedSol: round4(unrealizedSol),
      priceSol: round4(priceSol),
    };
  });

  holdings.sort((a, b) => b.currentValueSol - a.currentValueSol);

  const totals = holdings.reduce(
    (acc, h) => {
      acc.unrealizedSol += h.unrealizedSol;
      acc.currentValueSol += h.currentValueSol;
      return acc;
    },
    { unrealizedSol: 0, currentValueSol: 0 }
  );

  return NextResponse.json(
    {
      address,
      holdings,
      totals: {
        unrealizedSol: round4(totals.unrealizedSol),
        currentValueSol: round4(totals.currentValueSol),
      },
    },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60' } }
  );
}
