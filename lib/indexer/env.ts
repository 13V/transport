/**
 * ENV TUNING HELPERS
 *
 * Lets the indexer's cost-driving limits (how many wallets/coins/transactions
 * each run pulls from Helius) be capped via environment variables without a
 * code change — so Helius spend can be throttled from Vercel's env settings.
 */

/** Positive integer from env, else fallback. */
export function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
