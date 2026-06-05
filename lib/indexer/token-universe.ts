/**
 * TOKEN UNIVERSE
 *
 * Decides WHICH tokens the indexer scans for trades each run.
 *
 * We use DexScreener's free "boosted/trending" endpoints (no API key) to get a
 * rotating set of active Solana tokens. Smart-money wallets are found by looking
 * at who is trading the currently-active tokens — not the largest holders of
 * USDC/SOL (those are exchanges).
 */

import axios from 'axios';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

// Stablecoins / wrapped SOL — never treat these as "traded tokens".
const EXCLUDED_MINTS = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112',  // WSOL
]);

export interface UniverseToken {
  mint: string;
  symbol?: string;
}

/**
 * Fetch a set of currently-active Solana token mints to scan.
 * Combines "top boosts" and "latest boosts" for a mix of established + fresh,
 * then prioritizes pump.fun coins (mints ending in "pump") since they're the
 * focus of the smart-money leaderboard.
 */
export async function getTokenUniverse(limit = 30): Promise<UniverseToken[]> {
  const endpoints = [
    `${DEXSCREENER_BASE}/token-boosts/top/v1`,
    `${DEXSCREENER_BASE}/token-boosts/latest/v1`,
  ];

  const seen = new Set<string>();
  const tokens: UniverseToken[] = [];

  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      const list: any[] = Array.isArray(data) ? data : [];
      for (const item of list) {
        if (item?.chainId !== 'solana') continue;
        const mint: string | undefined = item?.tokenAddress;
        if (!mint || seen.has(mint) || EXCLUDED_MINTS.has(mint)) continue;
        seen.add(mint);
        tokens.push({ mint });
      }
    } catch (err) {
      console.error(`[UNIVERSE] Failed to fetch ${url}:`, (err as Error).message);
    }
  }

  // Pump.fun coins first, so the limited scan budget is spent where it matters.
  const isPump = (m: string) => m.toLowerCase().endsWith('pump');
  tokens.sort((a, b) => Number(isPump(b.mint)) - Number(isPump(a.mint)));

  return tokens.slice(0, limit);
}
