/**
 * TOKEN METADATA (DexScreener)
 *
 * Resolves on-chain token mints to a human-friendly { symbol, name, icon }
 * using DexScreener's public token endpoint, which supports batch lookups of
 * up to ~30 comma-separated mints per request.
 *
 * Design goals:
 *   - Resilient: never throws. On any network/parse failure we simply omit the
 *     affected mints, so the caller still gets whatever we could resolve.
 *   - Cheap: an in-memory cache (10 min TTL) means repeated polls of the same
 *     tokens don't re-hit the API. Only uncached/stale mints are fetched.
 *   - Dependency-light: uses the already-installed axios.
 */

import axios from 'axios';

export interface TokenMeta {
  symbol?: string;
  name?: string;
  icon?: string;
}

interface CacheEntry {
  meta: TokenMeta;
  ts: number;
}

const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60 * 1000; // 10 minutes
const BATCH_SIZE = 30; // DexScreener supports ~30 comma-separated mints per call
const REQUEST_TIMEOUT_MS = 5000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Numeric "weight" used to pick the best pair for a mint when several exist.
function pairWeight(pair: any): number {
  const liq = Number(pair?.liquidity?.usd);
  if (Number.isFinite(liq) && liq > 0) return liq;
  const vol = Number(pair?.volume?.h24);
  if (Number.isFinite(vol) && vol > 0) return vol;
  return 0;
}

function metaFromPair(pair: any): TokenMeta {
  const base = pair?.baseToken ?? {};
  const icon = pair?.info?.imageUrl || base?.icon || undefined;
  return {
    symbol: base?.symbol || undefined,
    name: base?.name || undefined,
    icon: typeof icon === 'string' && icon ? icon : undefined,
  };
}

/**
 * Resolve metadata for the given mints. Returns a Map keyed by mint; mints we
 * could not resolve are simply absent from the map.
 */
export async function getTokenMeta(
  mints: string[]
): Promise<Map<string, TokenMeta>> {
  const result = new Map<string, TokenMeta>();
  const now = Date.now();

  // Unique, non-empty mints.
  const unique = Array.from(new Set(mints.filter((m) => typeof m === 'string' && m)));

  // Serve from cache; collect the ones that need a fetch.
  const toFetch: string[] = [];
  for (const mint of unique) {
    const entry = CACHE.get(mint);
    if (entry && now - entry.ts < TTL_MS) {
      result.set(mint, entry.meta);
    } else {
      toFetch.push(mint);
    }
  }

  if (toFetch.length === 0) return result;

  // Track the best pair weight seen per mint within this fetch pass.
  const bestWeight = new Map<string, number>();

  for (const group of chunk(toFetch, BATCH_SIZE)) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${group.join(',')}`;
      const res = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });
      const pairs: any[] = Array.isArray(res.data?.pairs) ? res.data.pairs : [];

      for (const pair of pairs) {
        const addr = pair?.baseToken?.address;
        if (typeof addr !== 'string' || !addr) continue;
        // DexScreener may key by any of our requested mints; only accept ones
        // we asked for in this group.
        if (!group.includes(addr)) continue;

        const w = pairWeight(pair);
        const prev = bestWeight.get(addr);
        if (prev != null && w <= prev) continue;
        bestWeight.set(addr, w);

        const meta = metaFromPair(pair);
        result.set(addr, meta);
        CACHE.set(addr, { meta, ts: now });
      }
    } catch {
      // Swallow — leave this group's mints unresolved.
    }
  }

  return result;
}
