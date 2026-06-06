/**
 * TOKEN METADATA (DexScreener + Helius DAS)
 *
 * Resolves on-chain token mints to a human-friendly { symbol, name, icon }.
 *   1. DexScreener batch endpoint (≤30 mints/call) — great for name/symbol and
 *      icons of established/traded tokens.
 *   2. Helius DAS getAssetBatch (≤1000 ids/call) — fallback that reliably has
 *      images for fresh pump.fun coins where DexScreener has no `info.imageUrl`.
 *
 * Design goals:
 *   - Resilient: never throws. On any failure we omit the affected mints.
 *   - Cheap: in-memory cache (10 min TTL); only uncached/stale mints are fetched.
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
const DS_BATCH = 30; // DexScreener: ~30 comma-separated mints per call
const HELIUS_BATCH = 100; // DAS getAssetBatch supports up to 1000; keep payloads modest
const REQUEST_TIMEOUT_MS = 6000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Normalize ipfs:// and bare CIDs to an https gateway so <img> can render them. */
function normalizeUri(uri?: string): string | undefined {
  if (!uri || typeof uri !== 'string') return undefined;
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  if (uri.startsWith('http://')) return 'https://' + uri.slice('http://'.length);
  return uri;
}

// Numeric "weight" to pick the best pair for a mint when several exist.
function pairWeight(pair: any): number {
  const liq = Number(pair?.liquidity?.usd);
  if (Number.isFinite(liq) && liq > 0) return liq;
  const vol = Number(pair?.volume?.h24);
  if (Number.isFinite(vol) && vol > 0) return vol;
  return 0;
}

function metaFromPair(pair: any): TokenMeta {
  const base = pair?.baseToken ?? {};
  const addr = typeof base?.address === 'string' ? base.address : undefined;
  // Prefer the explicit profile image; otherwise fall back to DexScreener's
  // canonical token image CDN, which exists for most tokens DexScreener knows
  // (these tokens do — their name/symbol resolved). This is a fast, reliable
  // https URL, unlike the IPFS/arweave links Helius returns for fresh coins.
  const icon =
    pair?.info?.imageUrl ||
    base?.icon ||
    (addr ? `https://dd.dexscreener.com/ds-data/tokens/solana/${addr}.png` : undefined);
  return {
    symbol: base?.symbol || undefined,
    name: base?.name || undefined,
    icon: normalizeUri(typeof icon === 'string' && icon ? icon : undefined),
  };
}

/** DexScreener pass — fills the result/cache maps in place. */
async function fetchDexScreener(
  mints: string[],
  result: Map<string, TokenMeta>,
  now: number
): Promise<void> {
  const bestWeight = new Map<string, number>();
  for (const group of chunk(mints, DS_BATCH)) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${group.join(',')}`;
      const res = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });
      const pairs: any[] = Array.isArray(res.data?.pairs) ? res.data.pairs : [];
      for (const pair of pairs) {
        const addr = pair?.baseToken?.address;
        if (typeof addr !== 'string' || !addr || !group.includes(addr)) continue;
        const w = pairWeight(pair);
        const prev = bestWeight.get(addr);
        if (prev != null && w <= prev) continue;
        bestWeight.set(addr, w);
        const meta = metaFromPair(pair);
        result.set(addr, meta);
        CACHE.set(addr, { meta, ts: now });
      }
    } catch {
      // leave this group unresolved
    }
  }
}

/**
 * Helius DAS fallback — fills icon (and name/symbol when missing) for mints that
 * DexScreener couldn't fully resolve. Reliable for pump.fun token images.
 */
async function fetchHeliusImages(
  mints: string[],
  result: Map<string, TokenMeta>,
  now: number
): Promise<void> {
  const key = process.env.HELIUS_API_KEY;
  if (!key || mints.length === 0) return;
  const endpoint = `https://mainnet.helius-rpc.com/?api-key=${key}`;

  for (const group of chunk(mints, HELIUS_BATCH)) {
    try {
      const res = await axios.post(
        endpoint,
        { jsonrpc: '2.0', id: 'token-meta', method: 'getAssetBatch', params: { ids: group } },
        { timeout: REQUEST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
      );
      const assets: any[] = Array.isArray(res.data?.result) ? res.data.result : [];
      for (const a of assets) {
        const id = a?.id;
        if (typeof id !== 'string' || !id) continue;
        const content = a?.content ?? {};
        const file = Array.isArray(content?.files) ? content.files[0] : undefined;
        const image =
          normalizeUri(content?.links?.image) ||
          normalizeUri(file?.cdn_uri) ||
          normalizeUri(file?.uri);
        const md = content?.metadata ?? {};
        const prev = result.get(id) ?? {};
        const meta: TokenMeta = {
          symbol: prev.symbol || md?.symbol || undefined,
          name: prev.name || md?.name || undefined,
          icon: prev.icon || image || undefined,
        };
        result.set(id, meta);
        CACHE.set(id, { meta, ts: now });
      }
    } catch {
      // leave this group unresolved
    }
  }
}

/**
 * Resolve metadata for the given mints. Returns a Map keyed by mint; unresolved
 * mints are simply absent.
 */
export async function getTokenMeta(mints: string[]): Promise<Map<string, TokenMeta>> {
  const result = new Map<string, TokenMeta>();
  const now = Date.now();

  const unique = Array.from(new Set(mints.filter((m) => typeof m === 'string' && m)));

  const toFetch: string[] = [];
  for (const mint of unique) {
    const entry = CACHE.get(mint);
    if (entry && now - entry.ts < TTL_MS) result.set(mint, entry.meta);
    else toFetch.push(mint);
  }
  if (toFetch.length === 0) return result;

  await fetchDexScreener(toFetch, result, now);

  // Anything still missing an icon → try Helius for the image (and name/symbol).
  const needIcon = toFetch.filter((m) => !result.get(m)?.icon);
  if (needIcon.length > 0) await fetchHeliusImages(needIcon, result, now);

  return result;
}
