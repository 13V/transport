/**
 * SMART-WALLET CURATION
 *
 * Defines what makes a wallet "smart" — the quality gate that turns the raw,
 * indexer-populated leaderboard into a trustworthy list users can drop into a
 * trading terminal watchlist or Telegram alert bot.
 *
 * The heuristics are adapted from the gmgn bot's wallet auditor, re-expressed in
 * transport's units (realized PnL in SOL, not USD). The win-rate CAP is the key
 * anti-gaming rule: wallets that "never lose" are usually stat-farmers that hold
 * losers unrealized and only close winners.
 *
 * Every threshold is env-tunable so the bar can be moved without a deploy.
 */

export interface SmartCriteria {
  minPnlSol: number; // realized PnL floor (SOL)
  minWinRate: number; // 0..1
  maxWinRate: number; // 0..1 — cap rejects stat-farmers
  minTrades: number;
  minTokens: number;
  minScore: number; // composite SmartMoneyScore floor (0..100)
  maxIdleDays: number; // must have traded within this window (0 = no limit)
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export function getSmartCriteria(): SmartCriteria {
  return {
    minPnlSol: num('SMART_MIN_PNL_SOL', 5),
    minWinRate: num('SMART_MIN_WIN_RATE', 0.45),
    maxWinRate: num('SMART_MAX_WIN_RATE', 0.95),
    minTrades: num('SMART_MIN_TRADES', 15),
    minTokens: num('SMART_MIN_TOKENS', 4),
    minScore: num('SMART_MIN_SCORE', 0),
    maxIdleDays: num('SMART_MAX_IDLE_DAYS', 45),
  };
}

/** The fields curation needs; works for both DB rows and computed WalletStats. */
export interface CuratableStat {
  realizedPnl: number;
  winRate: number;
  totalTrades: number;
  tokensTraded: number;
  score: number;
  lastTradeAt?: string | Date | null;
  seeded?: boolean; // manually trusted → always qualifies
}

/**
 * Whether a wallet clears the smart-money bar. Manually-seeded wallets always
 * qualify (a human vouched for them); everyone else must clear the thresholds.
 */
export function isSmartWallet(
  s: CuratableStat,
  criteria: SmartCriteria = getSmartCriteria(),
  now: number = Date.now()
): boolean {
  if (s.seeded) return true;

  if (!(s.realizedPnl >= criteria.minPnlSol)) return false;
  if (s.winRate < criteria.minWinRate || s.winRate > criteria.maxWinRate) return false;
  if (s.totalTrades < criteria.minTrades) return false;
  if (s.tokensTraded < criteria.minTokens) return false;
  if (s.score < criteria.minScore) return false;

  if (criteria.maxIdleDays > 0 && s.lastTradeAt) {
    const last = new Date(s.lastTradeAt).getTime();
    if (Number.isFinite(last) && now - last > criteria.maxIdleDays * 86_400_000) {
      return false;
    }
  }
  return true;
}
