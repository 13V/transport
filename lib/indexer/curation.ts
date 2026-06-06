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
 * and a win-rate floor would wrongly exclude them.
 *
 * Every threshold is env-tunable so the bar can be moved without a deploy.
 */

import { detectBot } from './bot-filter';

export interface SmartCriteria {
  minRoiPct: number; // all-time realized ROI floor (%); requires an accurate ROI
  minPnlSol: number; // realized PnL floor (SOL) — keeps out tiny-size noise
  minInvestedSol: number; // min capital deployed, so ROI% is on real size (0 = off)
  minTrades: number;
  minTokens: number;
  maxWinRate: number; // upper cap to reject obvious stat-farmers (1 = disabled)
  maxIdleDays: number; // must have traded within this window (0 = no limit)
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export function getSmartCriteria(): SmartCriteria {
  return {
    minRoiPct: num('SMART_MIN_ROI_PCT', 0), // profitable
    minPnlSol: num('SMART_MIN_PNL_SOL', 1),
    minInvestedSol: num('SMART_MIN_INVESTED_SOL', 0), // off by default
    minTrades: num('SMART_MIN_TRADES', 10),
    minTokens: num('SMART_MIN_TOKENS', 3),
    maxWinRate: num('SMART_MAX_WIN_RATE', 1), // off by default
    maxIdleDays: num('SMART_MAX_IDLE_DAYS', 45),
  };
}

/** The fields curation needs; works for both DB rows and computed stats. */
export interface CuratableStat {
  realizedPnl: number;
  roiPct?: number | null; // accurate all-time ROI%; null when not deep-scanned
  investedSol?: number | null; // capital deployed (cost of sold quantity)
  winRate: number;
  totalTrades: number;
  tokensTraded: number;
  lastTradeAt?: string | Date | null;
  seeded?: boolean; // manually trusted → always qualifies
}

/**
 * Whether a wallet clears the smart-money bar. Manually-seeded wallets always
 * qualify. Everyone else must have an ACCURATE positive ROI (i.e. be verified),
 * real realized PnL, enough activity, and recent trading.
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
