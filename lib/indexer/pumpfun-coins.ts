/**
 * pumpfun-coins.ts
 *
 * Bulk / aged-winner source for the graduation scanner.
 *
 * DexScreener's snapshot only surfaces a tiny window of fresh pairs (~40 coins),
 * which starves the discovery pipeline of older graduates — coins that already
 * ran up to ~100k+ market cap. This module paginates pump.fun's public coins API
 * to bulk-source GRADUATED (complete) coins sorted by market cap, so the
 * graduation scanner has a deep pool of aged winners to work from.
 *
 * NOTE: pump.fun's API is UNOFFICIAL and may change without notice. Field names
 * and even the host vary between deployments. We therefore (a) try several base
 * URLs in order, (b) parse every field defensively with fallbacks, and (c) never
 * throw — on total failure we degrade to an empty array.
 */

import axios from 'axios';

export interface SourcedCoin {
  mint: string;
  symbol?: string;
  name?: string;
  marketCapUsd?: number;
  pairAddress?: string; // raydium / pump-swap pool address when available
  complete?: boolean; // graduated
}

/**
 * Well-known mints that are not tradeable meme tokens and should never be
 * surfaced by the discovery pipeline (USDC, USDT, Wrapped SOL).
 */
export const EXCLUDED_MINTS: ReadonlySet<string> = new Set<string>([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112', // Wrapped SOL
]);

/** Base URLs to try, in order. Different pump.fun deployments vary. */
const BASE_URLS: readonly string[] = [
  'https://frontend-api-v3.pump.fun/coins',
  'https://frontend-api-v2.pump.fun/coins',
  'https://frontend-api.pump.fun/coins',
];

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

const PAGE_LIMIT = 50;
const REQUEST_TIMEOUT_MS = 8000;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Loose shape of a pump.fun coin record; everything is optional/unknown. */
interface RawCoin {
  mint?: unknown;
  address?: unknown;
  coinMint?: unknown;
  symbol?: unknown;
  name?: unknown;
  usd_market_cap?: unknown;
  market_cap?: unknown;
  marketCap?: unknown;
  complete?: unknown;
  is_complete?: unknown;
  raydium_pool?: unknown;
  pump_swap_pool?: unknown;
  amm_pool?: unknown;
  market_id?: unknown;
  [key: string]: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Map a raw pump.fun record into a SourcedCoin, or null if it lacks a valid mint. */
function mapCoin(raw: RawCoin): SourcedCoin | null {
  const mint =
    asString(raw.mint) ?? asString(raw.address) ?? asString(raw.coinMint);
  if (!mint || !BASE58_RE.test(mint)) return null;
  if (EXCLUDED_MINTS.has(mint)) return null;

  const marketCapUsd =
    asNumber(raw.usd_market_cap) ??
    asNumber(raw.market_cap) ??
    asNumber(raw.marketCap);

  const pairAddress =
    asString(raw.raydium_pool) ??
    asString(raw.pump_swap_pool) ??
    asString(raw.amm_pool) ??
    asString(raw.market_id);

  let complete: boolean;
  if (typeof raw.complete === 'boolean') complete = raw.complete;
  else if (typeof raw.is_complete === 'boolean') complete = raw.is_complete;
  else
    complete = Boolean(
      raw.raydium_pool || raw.pump_swap_pool || raw.amm_pool,
    );

  return {
    mint,
    symbol: asString(raw.symbol),
    name: asString(raw.name),
    marketCapUsd,
    pairAddress,
    complete,
  };
}

/**
 * Bulk-source graduated pump.fun coins that ran up to a meaningful market cap.
 *
 * Walks up to `pages` pages (offset += limit) of the pump.fun coins API sorted
 * by market cap desc, keeping graduated coins with marketCapUsd >= minMcUsd,
 * de-duped by mint and capped at `maxCoins`. Never throws.
 */
export async function getPumpFunCoins(opts?: {
  minMcUsd?: number; // default 100_000 — "ran up to 100k MC" filter
  maxCoins?: number; // default 400 — cap total returned
  pages?: number; // default 12 — pagination pages to walk
  startPage?: number; // default 0 — first page to fetch (offset = startPage*limit)
  sort?: string; // default 'market_cap'
  order?: 'ASC' | 'DESC'; // default 'DESC'
}): Promise<SourcedCoin[]> {
  const minMcUsd = opts?.minMcUsd ?? 100_000;
  const maxCoins = opts?.maxCoins ?? 400;
  const pages = opts?.pages ?? 12;
  const startPage = Math.max(0, Math.trunc(opts?.startPage ?? 0));
  const sort = opts?.sort ?? 'market_cap';
  const order = opts?.order ?? 'DESC';

  const results: SourcedCoin[] = [];
  const seen = new Set<string>();

  try {
    for (const base of BASE_URLS) {
      let baseFailed = false;

      for (let page = startPage; page < startPage + pages; page++) {
        if (results.length >= maxCoins) break;

        const offset = page * PAGE_LIMIT;
        let coins: RawCoin[] | null = null;

        try {
          const { data } = await axios.get(base, {
            params: {
              offset,
              limit: PAGE_LIMIT,
              sort,
              order,
              includeNsfw: true,
            },
            headers: REQUEST_HEADERS,
            timeout: REQUEST_TIMEOUT_MS,
          });

          // Different deployments wrap the array differently.
          if (Array.isArray(data)) coins = data as RawCoin[];
          else if (data && Array.isArray((data as { coins?: unknown }).coins))
            coins = (data as { coins: RawCoin[] }).coins;
          else if (data && Array.isArray((data as { data?: unknown }).data))
            coins = (data as { data: RawCoin[] }).data;
          else coins = null;
        } catch {
          // Network / non-200 / parse failure for this base: fall through.
          baseFailed = true;
          break;
        }

        if (!coins) {
          baseFailed = true;
          break;
        }

        // Empty page => we've run out of coins on this base.
        if (coins.length === 0) break;

        for (const raw of coins) {
          if (results.length >= maxCoins) break;
          let mapped: SourcedCoin | null = null;
          try {
            mapped = mapCoin(raw);
          } catch {
            mapped = null; // a single bad record must not abort the page
          }
          if (!mapped) continue;
          if (!mapped.complete) continue; // graduated only
          if (mapped.marketCapUsd == null || mapped.marketCapUsd < minMcUsd)
            continue;
          if (seen.has(mapped.mint)) continue;
          seen.add(mapped.mint);
          results.push(mapped);
        }
      }

      // If this base produced results or completed cleanly, we're done.
      // Only advance to the next base when the current one failed outright.
      if (!baseFailed || results.length > 0) break;
    }
  } catch {
    // Catch-all: return whatever we collected rather than throwing.
  }

  return results.slice(0, maxCoins);
}
