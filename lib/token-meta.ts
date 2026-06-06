/**
 * TOKEN METADATA (DexScreener + Helius DAS)
 *
 * Resolves on-chain token mints to { symbol, name, icon, icons } where `icons`
 * is an ORDERED list of candidate image URLs the client tries in turn (first
 * that loads wins, else the letter avatar). This makes logos resilient:
 *   1. DexScreener profile image (when present)
 *   2. DexScreener token image CDN (exists for most DexScreener-known tokens)
 *   3. pump.fun / IPFS image from Helius DAS metadata, via a fast Pinata gateway
 *      and ipfs.io — covers fresh pump coins DexScreener has no image for.
 *
 * Resilient (never throws), cheap (10-min in-memory cache), dependency-light.
 */

import axios from 'axios';

export interface TokenMeta {
  symbol?: string;
  name?: string;
  icon?: string;       // best single candidate (icons[0]) — back-compat
  icons?: string[];    // ordered fallback chain
}

interface CacheEntry {
  meta: TokenMeta;
  ts: number;
}

const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60 * 1000;
const DS_BATCH = 30;
const HELIUS_BATCH = 100;
const REQUEST_TIMEOUT_MS = 6000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Build candidate URLs for an IPFS/arweave/http image, preferring fast gateways. */
function imageCandidates(raw?: string): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const out: string[] = [];
  // Extract an ipfs path from ipfs:// or any /ipfs/<cid...> gateway URL.
  let ipfsPath: string | undefined;
  if (raw.startsWith('ipfs://')) ipfsPath = raw.slice('ipfs://'.length).replace(/^ipfs\//, '');
  else {
    const m = raw.match(/\/ipfs\/([^?#]+)/);
    if (m) ipfsPath = m[1];
  }
  if (ipfsPath) {
    out.push(`https://pump.mypinata.cloud/ipfs/${ipfsPath}`); // what pump.fun itself serves
    out.push(`https://ipfs.io/ipfs/${ipfsPath}`);
  } else if (raw.startsWith('http://')) {
    out.push('https://' + raw.slice('http://'.length));
  } else if (raw.startsWith('https://')) {
    out.push(raw);
  }
  return out;
}

interface Acc { symbol?: string; name?: string; cands: string[] }

function pairWeight(pair: any): number {
  const liq = Number(pair?.liquidity?.usd);
  if (Number.isFinite(liq) && liq > 0) return liq;
  const vol = Number(pair?.volume?.h24);
  if (Number.isFinite(vol) && vol > 0) return vol;
  return 0;
}

async function fetchDexScreener(mints: string[], acc: Map<string, Acc>): Promise<void> {
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

        const base = pair.baseToken ?? {};
        const entry: Acc = acc.get(addr) ?? { cands: [] };
        entry.symbol = base?.symbol || entry.symbol;
        entry.name = base?.name || entry.name;
        const cands: string[] = [];
        if (typeof pair?.info?.imageUrl === 'string' && pair.info.imageUrl) cands.push(pair.info.imageUrl);
        if (typeof base?.icon === 'string' && base.icon) cands.push(base.icon);
        // DexScreener's canonical token-image CDN (fast; exists for most tokens).
        cands.push(`https://dd.dexscreener.com/ds-data/tokens/solana/${addr}.png`);
        entry.cands = [...entry.cands, ...cands];
        acc.set(addr, entry);
      }
    } catch {
      /* leave unresolved */
    }
  }
}

async function fetchHelius(mints: string[], acc: Map<string, Acc>): Promise<void> {
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
        const md = content?.metadata ?? {};
        const file = Array.isArray(content?.files) ? content.files[0] : undefined;
        const entry: Acc = acc.get(id) ?? { cands: [] };
        entry.symbol = entry.symbol || md?.symbol || undefined;
        entry.name = entry.name || md?.name || undefined;
        // pump.fun token image lives in the on-chain metadata (IPFS via Pinata).
        if (file?.cdn_uri) entry.cands.push(file.cdn_uri); // Helius-hosted CDN (fast)
        entry.cands.push(...imageCandidates(content?.links?.image));
        entry.cands.push(...imageCandidates(file?.uri));
        acc.set(id, entry);
      }
    } catch {
      /* leave unresolved */
    }
  }
}

function finalize(entry: Acc): TokenMeta {
  const icons = Array.from(new Set(entry.cands.filter((c) => typeof c === 'string' && c))).slice(0, 6);
  return { symbol: entry.symbol, name: entry.name, icon: icons[0], icons };
}

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

  const acc = new Map<string, Acc>();
  // DexScreener (names/symbols + fast CDN) and Helius (pump.fun image) in
  // parallel so we always have the IPFS image as a fallback candidate.
  await Promise.all([fetchDexScreener(toFetch, acc), fetchHelius(toFetch, acc)]);

  for (const mint of toFetch) {
    const entry = acc.get(mint);
    if (!entry) continue;
    const meta = finalize(entry);
    result.set(mint, meta);
    CACHE.set(mint, { meta, ts: now });
  }
  return result;
}
