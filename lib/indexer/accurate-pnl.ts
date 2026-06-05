/**
 * ACCURATE PnL — a single, correct realized-PnL / ROI engine.
 *
 * Written to fix the modeling bugs the audit found in pnl-engine.ts (three
 * disagreeing cost-basis models, a wrong ROI denominator, all-or-nothing sell
 * handling). This is the ONE source of truth for the headline number users see:
 * "this wallet is up X% all-time".
 *
 * Model (per token, then summed):
 *   - True FIFO lot matching. A SELL consumes the oldest buy lots first.
 *   - PARTIAL FILLS: a sell larger than current lots realizes what it can and
 *     the excess (a sell whose buy predates our history) is set aside as
 *     "unmatched" — never counted as profit, never as cost.
 *   - realized PnL = Σ matchedQty · (sellPrice − lotCost)
 *   - investedSol  = Σ matchedQty · lotCost   ← the cost of what was actually
 *     sold. THIS is the ROI denominator (not all capital ever deployed).
 *   - roiPct = realized / investedSol · 100
 *   - winRate = winning realized events / (winning + losing)   [break-even excluded]
 *
 * Inputs are SOL-quoted Trade objects (already fee-adjusted by the parser).
 * Trades are sorted chronologically (stable on equal timestamps) before replay.
 */

import type { Trade } from '../pnl-engine';

const EPS = 1e-9;

export interface AccuratePnL {
  realizedPnlSol: number; // total realized PnL (SOL), closed out across all tokens
  investedSol: number; // cost basis of the SOLD quantity — the ROI denominator
  roiPct: number; // realizedPnlSol / investedSol * 100 (0 when nothing realized)
  winRate: number; // 0..1 over realized events (break-even excluded)
  consistency: number; // share of closed tokens that ended net-positive
  realizedEvents: number; // count of sell↔lot matches (realized "trades")
  closedTokens: number; // distinct tokens with at least one realized event
  profitableTokens: number; // of those, how many ended net-positive
  tokensTraded: number; // distinct tokens touched
  totalTrades: number; // input trades
  unmatchedSoldSol: number; // proceeds from sells with no cost basis (excluded)
  remainingCostSol: number; // cost basis of tokens still held (open exposure)
  lastTradeAt: Date | null;
}

interface Lot {
  qty: number;
  costPerToken: number;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function computeAccuratePnL(trades: Trade[]): AccuratePnL {
  // Chronological replay, stable on equal (second-resolution) timestamps so
  // same-block trades keep their ingestion order rather than being FIFO-matched
  // in reverse.
  const ordered = trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.date.getTime() - b.t.date.getTime() || a.i - b.i)
    .map((x) => x.t);

  const lotsByToken = new Map<string, Lot[]>();
  const realizedByToken = new Map<string, number>(); // net realized per token
  const tokensTouched = new Set<string>();

  let realized = 0;
  let matchedCost = 0;
  let unmatchedProceeds = 0;
  let wins = 0;
  let losses = 0;
  let realizedEvents = 0;
  let lastTradeAt: Date | null = null;

  for (const tr of ordered) {
    tokensTouched.add(tr.tokenMint);
    if (!lastTradeAt || tr.date > lastTradeAt) lastTradeAt = tr.date;

    const lots = lotsByToken.get(tr.tokenMint) ?? [];

    if (tr.tradeType === 'BUY') {
      if (tr.amount > EPS) {
        lots.push({ qty: tr.amount, costPerToken: tr.pricePerToken });
        lotsByToken.set(tr.tokenMint, lots);
      }
      continue;
    }

    // SELL — consume oldest lots first.
    let remaining = tr.amount;
    const sellPrice = tr.pricePerToken;
    while (remaining > EPS && lots.length > 0) {
      const lot = lots[0];
      const q = Math.min(remaining, lot.qty);
      const lotCost = q * lot.costPerToken;
      const gain = q * sellPrice - lotCost;

      realized += gain;
      matchedCost += lotCost;
      realizedByToken.set(tr.tokenMint, (realizedByToken.get(tr.tokenMint) ?? 0) + gain);
      realizedEvents += 1;
      if (gain > EPS) wins += 1;
      else if (gain < -EPS) losses += 1;

      lot.qty -= q;
      remaining -= q;
      if (lot.qty <= EPS) lots.shift();
    }
    // Sold more than we have a cost basis for → exclude from PnL and ROI.
    if (remaining > EPS) unmatchedProceeds += remaining * sellPrice;
  }

  let remainingCost = 0;
  for (const lots of lotsByToken.values()) {
    for (const lot of lots) remainingCost += lot.qty * lot.costPerToken;
  }

  let profitableTokens = 0;
  for (const net of realizedByToken.values()) {
    if (net > EPS) profitableTokens += 1;
  }
  const closedTokens = realizedByToken.size;

  const roiPct = matchedCost > EPS ? (realized / matchedCost) * 100 : 0;
  const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;
  const consistency = closedTokens > 0 ? profitableTokens / closedTokens : 0;

  return {
    realizedPnlSol: round4(realized),
    investedSol: round4(matchedCost),
    roiPct: round4(roiPct),
    winRate: round4(winRate),
    consistency: round4(consistency),
    realizedEvents,
    closedTokens,
    profitableTokens,
    tokensTraded: tokensTouched.size,
    totalTrades: trades.length,
    unmatchedSoldSol: round4(unmatchedProceeds),
    remainingCostSol: round4(remainingCost),
    lastTradeAt,
  };
}
