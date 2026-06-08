/**
 * BOT / MEV / ARB FILTER
 *
 * A heuristic to flag wallets whose behavior looks automated — high-frequency
 * bots, MEV/sandwich runners, or arbitrageurs — rather than discretionary
 * "smart-money" traders. The curation gate (see curation.ts) decides who is up
 * X% all-time; this filter is a complementary EXCLUSION pass: even a profitable
 * wallet should be dropped from the curated list if it trades like a machine,
 * because users can't replicate it and following it adds noise.
 *
 * Design intent: CONSERVATIVE. A false positive (wrongly flagging a real
 * trader) is worse than a false negative (letting one bot through), so every
 * threshold is deliberately extreme. Each heuristic that triggers contributes a
 * short reason string; a wallet is flagged only if at least one fires.
 *
 * Pure and dependency-free — safe to call from anywhere (indexer, API, tests).
 */

// --- Thresholds (named consts so they're easy to audit/tune) -----------------

/**
 * 'hyperactive': a wallet that has made a huge number of trades but across very
 * few distinct tokens is churning the same names over and over — classic bot
 * behavior. We require BOTH a high absolute trade count and a high trades/token
 * ratio so a genuinely diversified active trader isn't caught.
 */
const HYPERACTIVE_MIN_TRADES = 500;
const HYPERACTIVE_MIN_TRADES_PER_TOKEN = 30;

/**
 * 'dust-size': average per-trade size so small it can't be discretionary alpha.
 * Tiny, uniform clip sizes are typical of MEV/sandwich and grid bots. Below
 * 0.01 SOL per trade is well under what a human sniper would bother with.
 */
const DUST_AVG_TRADE_SOL = 0.01;

/**
 * 'near-zero-edge-highvol': enormous volume with an ROI indistinguishable from
 * zero is the signature of arb/MEV — thousands of trades that each net ~nothing.
 * Real smart money shows meaningful asymmetric ROI, not a flat line at scale.
 */
const ZERO_EDGE_MIN_TRADES = 1000;
const ZERO_EDGE_MAX_ABS_ROI_PCT = 1; // |roi%| < 1 == effectively no edge

/**
 * 'extreme-winrate-highvol': a near-perfect win rate sustained over a
 * meaningful sample is statistically implausible for discretionary memecoin
 * trading and points to stat-farming / guaranteed-fill automation (e.g. JIT,
 * atomic arb) OR — just as often — incomplete history (a wallet whose losing
 * sells predate our scan window). The old 200-trade floor let the abundant
 * 100%-win / ~50-trade wallets sail through; 30 is low enough to catch those
 * while still demanding a sample large enough that 100% isn't pure luck.
 */
const EXTREME_WIN_RATE = 0.97;
const EXTREME_WIN_RATE_MIN_TRADES = 30;

export interface BotSignal {
  isLikelyBot: boolean;
  reasons: string[];
}

/**
 * Inspect a wallet's aggregate stats and return which (if any) bot signals fire.
 * All inputs are optional / nullable so this can run on partial DB rows or
 * window-only stats; a missing field simply can't trigger its heuristic.
 */
export function detectBot(w: {
  totalTrades?: number;
  tokensTraded?: number;
  realizedPnl?: number;
  investedSol?: number | null;
  roiPct?: number | null;
  winRate?: number;
  avgTradeSol?: number;
}): BotSignal {
  const reasons: string[] = [];

  const totalTrades = w.totalTrades ?? 0;
  const tokensTraded = w.tokensTraded ?? 0;

  // hyperactive — huge volume churned over very few tokens.
  if (
    totalTrades >= HYPERACTIVE_MIN_TRADES &&
    totalTrades / Math.max(tokensTraded, 1) >= HYPERACTIVE_MIN_TRADES_PER_TOKEN
  ) {
    reasons.push('hyperactive');
  }

  // dust-size — tiny, uniform per-trade size (MEV/sandwich/grid).
  if (w.avgTradeSol != null && w.avgTradeSol > 0 && w.avgTradeSol < DUST_AVG_TRADE_SOL) {
    reasons.push('dust-size');
  }

  // near-zero-edge-highvol — massive volume, ~0% edge (arb/MEV).
  if (
    totalTrades >= ZERO_EDGE_MIN_TRADES &&
    w.roiPct != null &&
    Math.abs(w.roiPct) < ZERO_EDGE_MAX_ABS_ROI_PCT
  ) {
    reasons.push('near-zero-edge-highvol');
  }

  // extreme-winrate-highvol — implausibly high win rate at scale.
  if (
    w.winRate != null &&
    w.winRate >= EXTREME_WIN_RATE &&
    totalTrades >= EXTREME_WIN_RATE_MIN_TRADES
  ) {
    reasons.push('extreme-winrate-highvol');
  }

  return { isLikelyBot: reasons.length > 0, reasons };
}
