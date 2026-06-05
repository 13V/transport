/**
 * WALLET TAGGING — a pure, deterministic classifier that turns a wallet's
 * computed stats into a coarse quality tier plus a set of descriptive tags.
 *
 * This is presentation/labeling logic only: it does NOT decide whether a wallet
 * is "smart" (see curation.ts for the qualification gate). It assigns a tier
 * from the wallet's composite score and attaches tags for traits worth
 * surfacing in a UI (whale, high ROI, sharpshooter, etc.).
 *
 * Field names mirror the curation/accurate-pnl stats: roiPct and investedSol
 * may be null (null = not deep-scanned / unknown), so null is treated as "does
 * not qualify" for any tag that depends on them.
 *
 * Pure and side-effect free: same input → same output, no I/O, no clock.
 */

// --- Tier cutoffs (composite score, higher = better) -------------------------
export const TIER_S_MIN = 70; // elite
export const TIER_A_MIN = 50; // strong
export const TIER_B_MIN = 30; // decent; below this is C

// --- Tag thresholds ----------------------------------------------------------
export const HIGH_ROI_MIN_PCT = 25; // all-time ROI% considered "high"
export const WHALE_MIN_INVESTED_SOL = 50; // capital deployed (SOL) to be a "whale"
export const CONSISTENT_MIN = 0.6; // share of closed tokens net-positive
export const HIGH_WINRATE_MIN = 0.6; // realized win rate considered "high"
export const SHARPSHOOTER_MAX_WINRATE = 0.4; // wins rarely but still profitable
export const ACTIVE_MIN_TRADES = 100; // total trades to be "active"
export const DIVERSIFIED_MIN_TOKENS = 30; // distinct tokens to be "diversified"

export type WalletTier = 'S' | 'A' | 'B' | 'C';

export interface WalletClassification {
  tier: WalletTier;
  tags: string[];
}

export function classifyWallet(w: {
  score?: number;
  roiPct?: number | null;
  realizedPnl?: number;
  investedSol?: number | null;
  winRate?: number;
  consistency?: number;
  totalTrades?: number;
  tokensTraded?: number;
}): WalletClassification {
  const score = w.score ?? 0;

  let tier: WalletTier;
  if (score >= TIER_S_MIN) tier = 'S';
  else if (score >= TIER_A_MIN) tier = 'A';
  else if (score >= TIER_B_MIN) tier = 'B';
  else tier = 'C';

  const roiPct = w.roiPct;
  const investedSol = w.investedSol ?? 0;
  const consistency = w.consistency ?? 0;
  const winRate = w.winRate ?? 0;
  const totalTrades = w.totalTrades ?? 0;
  const tokensTraded = w.tokensTraded ?? 0;

  const tags: string[] = [];

  if (roiPct != null && roiPct >= HIGH_ROI_MIN_PCT) tags.push('high-roi');
  if (investedSol >= WHALE_MIN_INVESTED_SOL) tags.push('whale');
  if (consistency >= CONSISTENT_MIN) tags.push('consistent');
  if (winRate >= HIGH_WINRATE_MIN) tags.push('high-winrate');
  if (winRate < SHARPSHOOTER_MAX_WINRATE && roiPct != null && roiPct > 0) {
    tags.push('sharpshooter');
  }
  if (totalTrades >= ACTIVE_MIN_TRADES) tags.push('active');
  if (tokensTraded >= DIVERSIFIED_MIN_TOKENS) tags.push('diversified');

  return { tier, tags };
}
