/**
 * TOKEN UNIVERSE
 *
 * Decides WHICH tokens the indexer scans for trades each run.
 *
 * We use DexScreener's free "boosted/trending" endpoints (no API key) to get a
 * rotating set of active Solana tokens. Smart-money wallets are found by looking
 * at who is trading the currently-active tokens — not the largest holders of
 * USDC/SOL (those are exchanges).
 *
 * Two levers keep each run targeting FRESH coins so the indexer keeps adding NEW
 * wallets instead of re-deduping the same trending head every time:
 *   - EXCLUDE coins already fully scanned recently (coins.full_scanned_at < ~24h).
 *   - ROTATE ordering/offset by an hour bucket so successive runs surface a
 *     different slice of the candidate pool.
 */

import axios from 'axios';
import { getSupabase, isSupabaseConfigured } from '../supabase-client';

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
 * Mints fully scanned within the last `withinMs` — exclude them so each run
 * targets fresh coins. Degrades to an empty set (no exclusion) on any error.
 */
async function getRecentlyScannedMints(withinMs: number): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (!isSupabaseConfigured()) return excluded;
  try {
    const since = new Date(Date.now() - withinMs).toISOString();
    const { data, error } = await getSupabase()
      .from('coins')
      .select('mint, full_scanned_at')
      .gte('full_scanned_at', since)
      .limit(5000);
    if (error || !data) return excluded;
    for (const row of data) {
      const mint = (row as { mint?: string }).mint;
      if (mint) excluded.add(mint);
    }
  } catch (err) {
    console.error('[UNIVERSE] recently-scanned exclusion query failed:', (err as Error).message);
  }
  return excluded;
}

/**
 * Fetch a set of currently-active Solana token mints to scan.
 * Combines "top boosts", "latest boosts" and newly-listed profiles for a mix of
 * established + fresh coins, then:
 *   - excludes coins already fully scanned in the last `excludeWithinMs`,
 *   - prioritizes pump.fun coins (mints ending in "pump"),
 *   - ROTATES the returned slice by an hour bucket so successive runs differ.
 *
 * Signature stays `getTokenUniverse(limit)`; rotation/exclusion are optional.
 */
export async function getTokenUniverse(
  limit = 30,
  opts: { excludeWithinMs?: number } = {}
): Promise<UniverseToken[]> {
  const excludeWithinMs = opts.excludeWithinMs ?? 24 * 60 * 60 * 1000;

  // Pull a LARGER candidate set from several DexScreener endpoints so a
  // high-volume backlog-feeding run sees a WIDER, fresher universe instead of
  // re-deduping the same ~30 trending coins every time. `token-profiles/latest`
  // surfaces newly-listed coins — exactly where fresh unverified wallets come from.
  const endpoints = [
    `${DEXSCREENER_BASE}/token-boosts/top/v1`,
    `${DEXSCREENER_BASE}/token-boosts/latest/v1`,
    `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
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

  // EXCLUDE coins already fully scanned recently so we target fresh coins.
  const recentlyScanned = await getRecentlyScannedMints(excludeWithinMs);
  const fresh = recentlyScanned.size
    ? tokens.filter((t) => !recentlyScanned.has(t.mint))
    : tokens;

  // Pump.fun coins first, so the limited scan budget is spent where it matters.
  const isPump = (m: string) => m.toLowerCase().endsWith('pump');
  fresh.sort((a, b) => Number(isPump(b.mint)) - Number(isPump(a.mint)));

  // ROTATE: vary the offset into the fresh pool by an hour bucket so successive
  // runs surface DIFFERENT coins instead of always re-scanning the same head.
  // The bucket-derived offset walks a `limit`-sized window through the pool,
  // wrapping around so the whole candidate set is covered over time.
  if (fresh.length <= limit) return fresh;
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const offset = (hourBucket * limit) % fresh.length;
  const rotated = [...fresh.slice(offset), ...fresh.slice(0, offset)];
  return rotated.slice(0, limit);
}
