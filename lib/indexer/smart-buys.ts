/**
 * SMART-MONEY BUY FLOW
 *
 * Surfaces the tokens that multiple VERIFIED smart wallets are buying right now.
 * The product framing: "smart money is rotating into X" — a strong signal when
 * several independently-curated wallets all open positions in the same token
 * inside a short window.
 *
 * Pipeline:
 *   1. Resolve the smart-wallet set (verified wallets that clear the curation
 *      gate in lib/indexer/curation.ts).
 *   2. Pull their recent BUY trades.
 *   3. Aggregate by token, ranking by how many DISTINCT smart wallets bought it.
 *
 * Degrades gracefully: if Supabase isn't configured, or the verified/roi_pct
 * columns don't exist yet, it returns an empty token list instead of throwing.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getSmartCriteria, isSmartWallet } from './curation';

export interface SmartBuyToken {
  mint: string;
  distinctSmartBuyers: number;
  buys: number;
  solVolume: number;
  firstBuy: string | null;
  lastBuy: string | null;
  sampleBuyers: string[];
}

export interface SmartMoneyBuysResult {
  generatedAt: string;
  hours: number;
  count: number;
  tokens: SmartBuyToken[];
}

const WALLET_CHUNK = 200; // Supabase .in() list size per query
const MAX_TRADE_ROWS = 3000; // hard cap on rows pulled across all chunks

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function getSmartMoneyBuys(
  opts?: { hours?: number; limit?: number }
): Promise<SmartMoneyBuysResult> {
  const hours = opts?.hours ?? 24;
  const limit = opts?.limit ?? 50;
  const generatedAt = new Date().toISOString();
  const empty: SmartMoneyBuysResult = { generatedAt, hours, count: 0, tokens: [] };

  if (!isSupabaseConfigured()) return empty;

  try {
    const supabase = getSupabase();
    const criteria = getSmartCriteria();
    const now = Date.now();

    // 1. Resolve the smart-wallet set. Only verified (deep-scanned) wallets have
    // a trustworthy all-time ROI, so we restrict to them and then apply the
    // full curation gate in JS.
    const statCols =
      'wallet, realized_pnl, roi_pct, invested_sol, win_rate, total_trades, tokens_traded, last_trade_at, seeded';
    const statRead = await supabase
      .from('wallet_stats')
      .select(statCols)
      .eq('verified', true);

    // If verified/roi_pct columns are missing (or any other query error),
    // degrade to an empty result rather than crashing the endpoint.
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

    // 2. Pull recent BUY trades for those wallets, newest first, across chunks.
    const sinceIso = new Date(now - hours * 3_600_000).toISOString();
    const trades: any[] = [];

    for (const group of chunk(smartWallets, WALLET_CHUNK)) {
      if (trades.length >= MAX_TRADE_ROWS) break;
      const remaining = MAX_TRADE_ROWS - trades.length;
      const tradeRead = await supabase
        .from('trades')
        .select('wallet, token_mint, trade_type, amount, price, block_time')
        .eq('trade_type', 'BUY')
        .in('wallet', group)
        .gte('block_time', sinceIso)
        .order('block_time', { ascending: false })
        .limit(remaining);

      if (tradeRead.error) return empty;
      if (tradeRead.data) trades.push(...tradeRead.data);
    }

    // 3. Aggregate by token_mint.
    interface Agg {
      mint: string;
      buyers: Set<string>;
      buys: number;
      solVolume: number;
      firstBuy: number | null;
      lastBuy: number | null;
      sampleBuyers: string[];
      sampleSeen: Set<string>;
    }
    const byMint = new Map<string, Agg>();

    for (const t of trades) {
      const mint = String(t.token_mint);
      if (!mint) continue;
      const wallet = String(t.wallet);
      const amount = Number(t.amount);
      const price = Number(t.price);
      const sol = Number.isFinite(amount) && Number.isFinite(price) ? amount * price : 0;
      const ts = t.block_time ? new Date(t.block_time).getTime() : NaN;

      let agg = byMint.get(mint);
      if (!agg) {
        agg = {
          mint,
          buyers: new Set(),
          buys: 0,
          solVolume: 0,
          firstBuy: null,
          lastBuy: null,
          sampleBuyers: [],
          sampleSeen: new Set(),
        };
        byMint.set(mint, agg);
      }

      agg.buyers.add(wallet);
      agg.buys += 1;
      agg.solVolume += sol;
      if (Number.isFinite(ts)) {
        if (agg.firstBuy == null || ts < agg.firstBuy) agg.firstBuy = ts;
        if (agg.lastBuy == null || ts > agg.lastBuy) agg.lastBuy = ts;
      }
      if (agg.sampleBuyers.length < 5 && !agg.sampleSeen.has(wallet)) {
        agg.sampleSeen.add(wallet);
        agg.sampleBuyers.push(wallet);
      }
    }

    const tokens: SmartBuyToken[] = Array.from(byMint.values())
      .map((a) => ({
        mint: a.mint,
        distinctSmartBuyers: a.buyers.size,
        buys: a.buys,
        solVolume: Math.round(a.solVolume * 1e4) / 1e4,
        firstBuy: a.firstBuy == null ? null : new Date(a.firstBuy).toISOString(),
        lastBuy: a.lastBuy == null ? null : new Date(a.lastBuy).toISOString(),
        sampleBuyers: a.sampleBuyers,
      }))
      .sort(
        (a, b) =>
          b.distinctSmartBuyers - a.distinctSmartBuyers || b.solVolume - a.solVolume
      )
      .slice(0, limit);

    return { generatedAt, hours, count: tokens.length, tokens };
  } catch {
    return empty;
  }
}
