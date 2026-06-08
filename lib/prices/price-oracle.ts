/**
 * PRICE ORACLE (SOL-denominated)
 *
 *   fetchTokenPricesSol(mints) — current price of each mint expressed in SOL.
 *
 * Prices come from DexScreener's batched token endpoint
 * (`/latest/dex/tokens/{csv}`, max 30 mints per call — same contract the
 * graduation indexer uses). For every mint we pick the highest-liquidity
 * Solana pair and resolve a SOL price:
 *
 *   1. If the pair is quoted in SOL/WSOL, `priceNative` already IS the
 *      SOL price — just parse it.
 *   2. Otherwise fall back to `priceUsd / solUsd` when we can establish a
 *      SOL/USD reference from one of the pairs in the batch; if neither is
 *      available the mint is skipped (left out of the returned Map).
 *
 * Results are cached in-module for ~60s so repeated holdings lookups don't
 * hammer the API. The whole thing is resilient: a failed chunk is skipped,
 * never thrown, so a partial outage still yields partial prices.
 */

import axios from 'axios';

const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens';
const CHUNK_SIZE = 30;
const CACHE_TTL_MS = 60_000;

// Wrapped SOL — DexScreener quotes most pump.fun pairs against this.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SOL_SYMBOLS = new Set(['SOL', 'WSOL']);

interface CacheEntry {
  priceSol: number;
  at: number;
}

// mint -> { priceSol, at } ; entries older than CACHE_TTL_MS are ignored.
const priceCache = new Map<string, CacheEntry>();

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
}

function liquidityUsd(pair: DexPair): number {
  const v = Number(pair?.liquidity?.usd);
  return Number.isFinite(v) ? v : 0;
}

function isSolQuote(pair: DexPair): boolean {
  const addr = pair?.quoteToken?.address;
  const sym = String(pair?.quoteToken?.symbol ?? '').toUpperCase();
  return addr === WSOL_MINT || SOL_SYMBOLS.has(sym);
}

/**
 * Derive a SOL/USD reference price from a batch of pairs. Any SOL-quoted pair
 * gives us (priceUsd of base) / (priceNative of base) = USD per SOL, since
 * priceNative is the base price in SOL and priceUsd is the same in USD.
 * We take the value from the deepest-liquidity SOL-quoted pair available.
 */
function deriveSolUsd(pairs: DexPair[]): number | null {
  let best: number | null = null;
  let bestLiq = -1;
  for (const p of pairs) {
    if (p?.chainId !== 'solana' || !isSolQuote(p)) continue;
    const native = Number(p?.priceNative);
    const usd = Number(p?.priceUsd);
    if (!Number.isFinite(native) || native <= 0 || !Number.isFinite(usd) || usd <= 0) {
      continue;
    }
    const liq = liquidityUsd(p);
    if (liq > bestLiq) {
      bestLiq = liq;
      best = usd / native;
    }
  }
  return best && best > 0 ? best : null;
}

/** Resolve the SOL price for a single mint from its best Solana pair. */
function priceForMint(
  mint: string,
  pairs: DexPair[],
  solUsd: number | null
): number | null {
  let best: DexPair | null = null;
  let bestLiq = -1;
  for (const p of pairs) {
    if (p?.chainId !== 'solana') continue;
    if (p?.baseToken?.address !== mint) continue;
    const liq = liquidityUsd(p);
    if (liq > bestLiq) {
      bestLiq = liq;
      best = p;
    }
  }
  if (!best) return null;

  // Preferred path: pair quoted in SOL → priceNative is already SOL price.
  if (isSolQuote(best)) {
    const native = Number(best.priceNative);
    if (Number.isFinite(native) && native > 0) return native;
  }

  // Fallback: convert USD price into SOL using a SOL/USD reference.
  if (solUsd && solUsd > 0) {
    const usd = Number(best.priceUsd);
    if (Number.isFinite(usd) && usd > 0) return usd / solUsd;
  }

  return null;
}

async function fetchChunk(mints: string[]): Promise<DexPair[]> {
  try {
    const { data } = await axios.get(`${DEXSCREENER_TOKENS}/${mints.join(',')}`, {
      timeout: 12000,
    });
    return Array.isArray(data?.pairs) ? (data.pairs as DexPair[]) : [];
  } catch (err) {
    console.error('[PRICE] chunk fetch failed:', (err as Error).message);
    return [];
  }
}

export interface FetchTokenPricesOptions {
  /**
   * Override the cache freshness window for THIS call (ms). A cached entry is
   * only served when it is younger than this; older entries are force-refetched.
   * Used by the LIVE-burst surface to demand a ~15-20s-fresh current price
   * (which tracks BUYS *and* SELLS), without lowering the module-wide
   * CACHE_TTL_MS that the rest of the app relies on. Capped at CACHE_TTL_MS — a
   * larger value would never refresh more often than the base TTL anyway.
   */
  maxAgeMs?: number;
}

/**
 * Current SOL-denominated price for each mint. Missing/illiquid/USD-only-with-
 * no-reference mints are omitted from the Map rather than returned as 0.
 */
export async function fetchTokenPricesSol(
  mints: string[],
  options?: FetchTokenPricesOptions
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const now = Date.now();

  // Effective freshness window: the caller may demand fresher than the base TTL
  // (e.g. the live feed wants ~15s), but never staler than CACHE_TTL_MS.
  const maxAge =
    options?.maxAgeMs != null && Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
      ? Math.min(options.maxAgeMs, CACHE_TTL_MS)
      : CACHE_TTL_MS;

  // Dedupe and serve fresh cache hits; collect the rest for fetching.
  const toFetch: string[] = [];
  const seen = new Set<string>();
  for (const mint of mints) {
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    const cached = priceCache.get(mint);
    if (cached && now - cached.at < maxAge) {
      out.set(mint, cached.priceSol);
    } else {
      toFetch.push(mint);
    }
  }

  for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
    const chunk = toFetch.slice(i, i + CHUNK_SIZE);
    const pairs = await fetchChunk(chunk);
    if (pairs.length === 0) continue; // skip failed/empty chunk

    const solUsd = deriveSolUsd(pairs);
    for (const mint of chunk) {
      const priceSol = priceForMint(mint, pairs, solUsd);
      if (priceSol != null) {
        out.set(mint, priceSol);
        priceCache.set(mint, { priceSol, at: Date.now() });
      }
    }
  }

  return out;
}
