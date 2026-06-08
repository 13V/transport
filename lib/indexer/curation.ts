/**
 * SMART-WALLET CURATION
 *
 * Defines what makes a wallet "smart" — the quality gate that turns the raw,
 * indexer-populated leaderboard into a trustworthy list users can drop into a
 * trading terminal watchlist or Telegram alert bot.
 *
 * The product framing is "this wallet is up X% all-time", so the gate is
 * ROI-centric: a wallet qualifies if it has an ACCURATE (deep-scanned) positive
 * all-time ROI on real money, with enough activity to be meaningful and recent
 * enough to be worth tracking. We deliberately do NOT require a high win rate —
 * the best snipers win well under half their trades but win big (asymmetric),
 * and a win-rate floor would wrongly exclude them. Instead of a win-rate FLOOR
 * we use a PROFIT-FACTOR floor (gross wins / gross losses): it captures the same
 * "is the edge real" intent while rewarding asymmetry rather than punishing it.
 *
 * The anchor is ROI + invested capital, NOT an absolute PnL floor: a wallet that
 * turned 0.6 SOL into 3 SOL (a genuinely-smart small-size trader) is just as
 * "smart" as one that turned 60 into 90. A high absolute-PnL floor was the
 * dominant false-negative — it rejected high-ROI small wallets — so the PnL floor
 * is kept modest while minInvestedSol guarantees the ROI% is measured on real,
 * non-trivial size so dust-ROI farmers can't slip through.
 *
 * SIGNAL QUALITY (this revision): the old gate was far too loose — a wallet up
 * 0.01% over 6 trades qualified. The defaults below are tightened substantially
 * (ROI≥30%, ≥30 trades, ≥10 tokens, ≥5 SOL invested, ≥2 SOL realized) and add
 * two edge gates: minConsistency (share of closed tokens net-positive) and
 * minProfitFactor (asymmetry). A near-perfect win rate (≥0.95) over a large
 * realized sample is treated as SUSPECT (almost always incomplete history in
 * memecoins, not skill) and rejected. This deliberately SHRINKS the smart set —
 * quality over quantity — so "smart money" is defensibly smart.
 *
 * Every threshold is env-tunable so the bar can be moved without a deploy.
 */

import { detectBot } from './bot-filter';

export interface SmartCriteria {
  minRoiPct: number; // all-time realized ROI floor (%); requires an accurate ROI
  minPnlSol: number; // realized PnL floor (SOL)
  minInvestedSol: number; // min capital deployed, so ROI% is on real size (0 = off)
  minTrades: number;
  minTokens: number;
  maxWinRate: number; // upper cap to reject obvious stat-farmers (1 = disabled)
  maxIdleDays: number; // must have traded within this window (0 = no limit)
  // --- edge / suspect gates (optional so older callers/fixtures still type-check;
  // getSmartCriteria() always populates them and isSmartWallet() applies the
  // documented defaults below when a field is omitted). ---
  minConsistency?: number; // min share of closed tokens net-positive (0 = off)
  minProfitFactor?: number; // min gross-wins/gross-losses asymmetry (0 = off)
  suspectWinRate?: number; // win rate at/above which a LARGE sample is rejected as suspect (1 = off)
  suspectMinEvents?: number; // realized-event count above which suspectWinRate applies
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

// Documented defaults for the edge/suspect gates. Used both by getSmartCriteria
// (as env fallbacks) and by isSmartWallet when a caller passes a partial
// SmartCriteria that omits these (optional) fields — so the gate behaves the
// same whether or not the field was supplied.
//
// ROLLOUT NOTE: consistency/profit_factor floors ship DISABLED (0) by default.
// profit_factor is a new column (migration 0013) that's NULL until wallets are
// re-scanned AND the gate's SELECT is wired to fetch it; enabling it before then
// (null → fail) would collapse the smart set. Turn them on via
// SMART_MIN_CONSISTENCY / SMART_MIN_PROFIT_FACTOR once data is populated.
const DEFAULT_MIN_CONSISTENCY = 0;
const DEFAULT_MIN_PROFIT_FACTOR = 0;
const DEFAULT_SUSPECT_WIN_RATE = 0.95;
const DEFAULT_SUSPECT_MIN_EVENTS = 30;

export function getSmartCriteria(): SmartCriteria {
  return {
    // ROI must be a real, non-trivial edge — not "up 0.01%".
    minRoiPct: num('SMART_MIN_ROI_PCT', 30),
    // Realized PnL floor — modest size guard on top of the ROI/invested anchor.
    minPnlSol: num('SMART_MIN_PNL_SOL', 2),
    // Capital deployed must be non-trivial so ROI% is measured on real size.
    minInvestedSol: num('SMART_MIN_INVESTED_SOL', 5),
    // Enough decisions to be a track record, not a few lucky flips.
    minTrades: num('SMART_MIN_TRADES', 30),
    minTokens: num('SMART_MIN_TOKENS', 10),
    // At least ~40% of CLOSED tokens ended net-positive: rules out one-moonshot,
    // many-rugs wallets even when their summed ROI looks great.
    minConsistency: num('SMART_MIN_CONSISTENCY', DEFAULT_MIN_CONSISTENCY),
    // Asymmetry floor (gross wins / gross losses). 1.5 = wins outweigh losses by
    // 50%; this replaces a win-rate FLOOR while still demanding a real edge.
    // Wallets with no realized losses report a huge profit factor and pass — the
    // suspectWinRate rule below catches the "too clean to be real" subset.
    minProfitFactor: num('SMART_MIN_PROFIT_FACTOR', DEFAULT_MIN_PROFIT_FACTOR),
    maxWinRate: num('SMART_MAX_WIN_RATE', 1), // hard cap; off by default
    // A ≥95% win rate over a LARGE realized sample (≥ suspectMinEvents) is almost
    // always incomplete history in memecoins, not skill — reject it. A small
    // sample at 100% is statistically unremarkable, so it's left to pass.
    suspectWinRate: num('SMART_SUSPECT_WIN_RATE', DEFAULT_SUSPECT_WIN_RATE),
    suspectMinEvents: num('SMART_SUSPECT_MIN_EVENTS', DEFAULT_SUSPECT_MIN_EVENTS),
    maxIdleDays: num('SMART_MAX_IDLE_DAYS', 90),
  };
}

/** The fields curation needs; works for both DB rows and computed stats. */
export interface CuratableStat {
  realizedPnl: number;
  roiPct?: number | null; // accurate all-time ROI%; null when not deep-scanned
  investedSol?: number | null; // capital deployed (cost of sold quantity)
  winRate: number;
  profitFactor?: number | null; // gross wins / gross losses; null when not (re-)scanned
  consistency?: number | null; // share of closed tokens net-positive; null when not (re-)scanned
  realizedEvents?: number | null; // count of realized sell↔lot matches (sample size for suspect rule)
  totalTrades: number;
  tokensTraded: number;
  lastTradeAt?: string | Date | null;
  seeded?: boolean; // manually trusted → always qualifies
}

/**
 * Whether a wallet clears the smart-money bar. Manually-seeded wallets always
 * qualify. Everyone else must have an ACCURATE positive ROI (i.e. be verified),
 * real realized PnL, enough activity, a defensible EDGE (profit factor +
 * consistency), and recent trading.
 *
 * NULL HANDLING: profitFactor and consistency are populated by the accurate-PnL
 * re-scan (migration 0013). Wallets scored BEFORE that re-scan have these null
 * and will FAIL the new edge floors — i.e. they drop out of the smart set until
 * re-scanned. This is intentional and coordinated with the truncation re-scan:
 * a wallet must be (re)scored with the current engine to be called smart. Set
 * the corresponding SMART_MIN_* env to 0 to disable a floor (and let nulls pass).
 */
export function isSmartWallet(
  s: CuratableStat,
  criteria: SmartCriteria = getSmartCriteria(),
  now: number = Date.now()
): boolean {
  if (s.seeded) return true;

  // ROI must be present (deep-scanned/verified) and clear the floor. Window-only
  // stats have no trustworthy ROI, so they don't qualify as "smart".
  if (s.roiPct == null || s.roiPct < criteria.minRoiPct) return false;
  if (!(s.realizedPnl >= criteria.minPnlSol)) return false;
  if (criteria.minInvestedSol > 0 && !((s.investedSol ?? 0) >= criteria.minInvestedSol)) return false;
  if (criteria.maxWinRate < 1 && s.winRate > criteria.maxWinRate) return false;
  if (s.totalTrades < criteria.minTrades) return false;
  if (s.tokensTraded < criteria.minTokens) return false;

  // Resolve the optional edge/suspect gates to their documented defaults when a
  // caller passes a partial SmartCriteria that omits them.
  const minConsistency = criteria.minConsistency ?? DEFAULT_MIN_CONSISTENCY;
  const minProfitFactor = criteria.minProfitFactor ?? DEFAULT_MIN_PROFIT_FACTOR;
  const suspectWinRate = criteria.suspectWinRate ?? DEFAULT_SUSPECT_WIN_RATE;
  const suspectMinEvents = criteria.suspectMinEvents ?? DEFAULT_SUSPECT_MIN_EVENTS;

  // EDGE: consistency — enough closed tokens ended net-positive. Null = not
  // re-scanned with the current engine → fails (unless the floor is disabled).
  if (minConsistency > 0 && !((s.consistency ?? -1) >= minConsistency)) {
    return false;
  }

  // EDGE: profit factor (asymmetry). Null = not re-scanned → fails (unless off).
  // A wallet with no realized losses reports a very large/Infinity profit factor
  // and clears this; the suspect-win-rate rule below is what catches the
  // "too-clean to be real" subset of those.
  if (minProfitFactor > 0 && !((s.profitFactor ?? -1) >= minProfitFactor)) {
    return false;
  }

  // SUSPECT win rate: a ≥95% win rate over a LARGE realized sample is, in
  // memecoins, almost always incomplete history (losing sells that predate our
  // scan) rather than skill — reject it. A small sample at 100% is statistically
  // unremarkable, so it is allowed through. realizedEvents is the sample size;
  // when it's unknown we conservatively fall back to totalTrades.
  if (suspectWinRate < 1) {
    const sample = s.realizedEvents ?? s.totalTrades;
    if (s.winRate >= suspectWinRate && sample >= suspectMinEvents) {
      return false;
    }
  }

  // Exclude likely bots / MEV / arb unless explicitly disabled (SMART_ALLOW_BOTS=1).
  if (process.env.SMART_ALLOW_BOTS !== '1') {
    const avgTradeSol =
      s.totalTrades > 0 && s.investedSol != null ? s.investedSol / s.totalTrades : undefined;
    if (
      detectBot({
        totalTrades: s.totalTrades,
        tokensTraded: s.tokensTraded,
        realizedPnl: s.realizedPnl,
        investedSol: s.investedSol,
        roiPct: s.roiPct,
        winRate: s.winRate,
        avgTradeSol,
      }).isLikelyBot
    ) {
      return false;
    }
  }

  if (criteria.maxIdleDays > 0 && s.lastTradeAt) {
    const last = new Date(s.lastTradeAt).getTime();
    if (Number.isFinite(last) && now - last > criteria.maxIdleDays * 86_400_000) {
      return false;
    }
  }
  return true;
}
