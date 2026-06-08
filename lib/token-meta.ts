/**
 * TOKEN METADATA (DexScreener + Helius DAS)
 *
 * Resolves on-chain token mints to { symbol, name, icon, icons } where `icons`
 * is an ORDERED list of candidate image URLs the client tries in turn (first
 * that loads wins, else the letter avatar). This makes logos resilient:
 *   1. DexScreener profile image (when present)
 *   2. DexScreener token image CDN (exists for most DexScreener-known tokens)
 *   3. pump.fun / IPFS image from Helius DAS metadata (image link, metadata.image,
 *      and file uri), each fanned out across several independent IPFS gateways
 *      (Pinata, ipfs.io, Cloudflare, nft.storage, dweb.link) so one slow/down
 *      gateway can't kill the logo — covers fresh pump coins DexScreener has no
 *      image for yet.
 *
 * Resilient (never throws), cheap (10-min in-memory cache), dependency-light.
 */

import axios from 'axios';

export interface TokenLink {
  kind: string; // website | twitter | telegram | discord | …
  url: string;
}

export interface TokenMeta {
  symbol?: string;
  name?: string;
  icon?: string;       // best single candidate (icons[0]) — back-compat
  icons?: string[];    // ordered fallback chain
  links?: TokenLink[]; // website / socials
  description?: string;
  // Live market stats (from the highest-liquidity DexScreener pair).
  pairAddress?: string;   // for the DexScreener chart embed
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange24h?: number; // 24h % change
  // Trading activity on the busiest pair (honeypot / sell-pressure proxy).
  buys24h?: number;        // DexScreener pair.txns.h24.buys
  sells24h?: number;       // DexScreener pair.txns.h24.sells
  pairCreatedAt?: number;  // epoch ms — DexScreener pair.pairCreatedAt (token age)
  // Rug / safety signals (from Helius DAS token_info).
  mintRenounced?: boolean;   // mint_authority null/absent ⇒ true (no new supply)
  freezeRenounced?: boolean; // freeze_authority null/absent ⇒ true (can't freeze)
  // Largest NON-pool holder as % of supply (concentration / rug proxy).
  // Best-effort: undefined when not computed or on any failure.
  topHolderPct?: number;
}

interface CacheEntry {
  meta: TokenMeta;
  ts: number;
}

const CACHE = new Map<string, CacheEntry>();
// 2-min cache: fresh enough for a volatile pumping token's price/market-cap on
// the token page, while still sparing DexScreener from per-request calls when the
// buying feed enriches many mints at once.
const TTL_MS = 2 * 60 * 1000;
const DS_BATCH = 30;
const HELIUS_BATCH = 100;
const REQUEST_TIMEOUT_MS = 6000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Wrap a raw image URL through the free, no-auth wsrv.nl (weserv) image proxy.
 *
 * Why this is the PRIMARY candidate, not a nicety:
 *  - It fetches the source SERVER-SIDE, so the browser never sends (or omits) a
 *    Referer/Origin to the origin. That sidesteps DexScreener's CDN hotlink
 *    protection (dd.dexscreener.com returns 403 when the request has no
 *    referrer — exactly what `referrerPolicy="no-referrer"` produces) and any
 *    CORS/referrer quirks on IPFS gateways.
 *  - It caches + transcodes to a small 64px webp, so slow/cold IPFS gateways are
 *    served fast from the proxy's edge cache instead of timing out per client.
 * The raw URL is always kept as a later fallback in case the proxy is down.
 */
function proxied(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  // wsrv wants the url WITHOUT the scheme (or url-encoded). Encode to be safe.
  const stripped = raw.replace(/^https?:\/\//, '');
  return `https://wsrv.nl/?url=${encodeURIComponent(stripped)}&w=64&h=64&fit=cover&output=webp&default=1`;
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
    // Multiple independent gateways so a single slow/down gateway can't kill the
    // logo — the client tries them in order and stops at the first that loads.
    // NOTE: cloudflare-ipfs.com was REMOVED — Cloudflare permanently shut down
    // their public IPFS gateway (NXDOMAIN now), so it only ever wasted a slot.
    out.push(`https://pump.mypinata.cloud/ipfs/${ipfsPath}`); // what pump.fun itself serves
    out.push(`https://ipfs.io/ipfs/${ipfsPath}`);
    out.push(`https://nftstorage.link/ipfs/${ipfsPath}`);
    out.push(`https://dweb.link/ipfs/${ipfsPath}`);
  } else if (raw.startsWith('http://')) {
    out.push('https://' + raw.slice('http://'.length));
  } else if (raw.startsWith('https://')) {
    out.push(raw);
  }
  return out;
}

interface Acc {
  symbol?: string; name?: string; cands: string[]; links: TokenLink[]; description?: string;
  pairAddress?: string; priceUsd?: number; marketCapUsd?: number;
  liquidityUsd?: number; volume24hUsd?: number; priceChange24h?: number;
  buys24h?: number; sells24h?: number; pairCreatedAt?: number;
  mintRenounced?: boolean; freezeRenounced?: boolean;
  // Raw token supply (smallest units) + decimals from DAS, for topHolderPct.
  supplyRaw?: number; decimals?: number;
  topHolderPct?: number;
}

function numOrU(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Normalize a social/website entry to an absolute https URL, else skip.
function normLink(url?: string): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  if (url.startsWith('http://')) return 'https://' + url.slice(7);
  if (url.startsWith('https://')) return url;
  return undefined;
}

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
        const info = pair.info ?? {};
        const entry: Acc = acc.get(addr) ?? { cands: [], links: [] };
        entry.symbol = base?.symbol || entry.symbol;
        entry.name = base?.name || entry.name;
        // This block only runs for the highest-weight pair seen so far, so the
        // last write wins — i.e. these are the busiest pool's live stats.
        entry.pairAddress = pair?.pairAddress || entry.pairAddress;
        entry.priceUsd = numOrU(pair?.priceUsd) ?? entry.priceUsd;
        // "Market cap" in memecoin land = FDV (price × total supply) — that's what
        // Axiom / GMGN / BullX / pump.fun all display. DexScreener's `marketCap`
        // field is circulating-supply based and reads ~half for many pump tokens,
        // so prefer fdv and only fall back to marketCap when fdv is absent.
        entry.marketCapUsd = numOrU(pair?.fdv) ?? numOrU(pair?.marketCap) ?? entry.marketCapUsd;
        entry.liquidityUsd = numOrU(pair?.liquidity?.usd) ?? entry.liquidityUsd;
        entry.volume24hUsd = numOrU(pair?.volume?.h24) ?? entry.volume24hUsd;
        entry.priceChange24h = numOrU(pair?.priceChange?.h24) ?? entry.priceChange24h;
        // 24h buy/sell counts (honeypot / sell-pressure proxy) + pair age.
        entry.buys24h = numOrU(pair?.txns?.h24?.buys) ?? entry.buys24h;
        entry.sells24h = numOrU(pair?.txns?.h24?.sells) ?? entry.sells24h;
        entry.pairCreatedAt = numOrU(pair?.pairCreatedAt) ?? entry.pairCreatedAt;
        const cands: string[] = [];
        // DexScreener's canonical token-image CDN first (exists for ~every
        // DexScreener-known token, and since market cap renders the token IS
        // known). info.imageUrl/base.icon are only present for tokens with a
        // curated profile, so they come after as extra coverage.
        cands.push(`https://dd.dexscreener.com/ds-data/tokens/solana/${addr}.png`);
        if (typeof info?.imageUrl === 'string' && info.imageUrl) cands.push(info.imageUrl);
        if (typeof base?.icon === 'string' && base.icon) cands.push(base.icon);
        entry.cands = [...entry.cands, ...cands];
        // Websites + socials (only present for tokens with a DexScreener profile).
        for (const w of Array.isArray(info?.websites) ? info.websites : []) {
          const url = normLink(w?.url);
          if (url) entry.links.push({ kind: String(w?.label || 'website').toLowerCase(), url });
        }
        for (const s of Array.isArray(info?.socials) ? info.socials : []) {
          const url = normLink(s?.url || s?.handle);
          if (url) entry.links.push({ kind: String(s?.type || s?.platform || 'link').toLowerCase(), url });
        }
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
        const entry: Acc = acc.get(id) ?? { cands: [], links: [] };
        entry.symbol = entry.symbol || md?.symbol || undefined;
        entry.name = entry.name || md?.name || undefined;
        if (!entry.description && typeof md?.description === 'string' && md.description.trim()) {
          entry.description = md.description.trim();
        }
        const ext = normLink(content?.links?.external_url);
        if (ext && !entry.links.some((l) => l.url === ext)) entry.links.push({ kind: 'website', url: ext });
        // Rug / safety: authorities. DAS surfaces these in token_info
        // (mint_authority / freeze_authority) and/or the authorities[] array.
        // null / absent ⇒ renounced. We treat "field present in response AND
        // empty" as renounced; if the response lacks the field entirely we still
        // default to renounced=true (pump.fun mints renounce on graduation), but
        // only set the flag when token_info exists so we don't fabricate it.
        const ti = a?.token_info ?? {};
        const auths: any[] = Array.isArray(a?.authorities) ? a.authorities : [];
        if (a?.token_info || auths.length) {
          const mintAuth = ti?.mint_authority;
          const freezeAuth = ti?.freeze_authority;
          // authorities[] lists active authorities by scope; presence of a
          // "full"/mint authority there means NOT renounced.
          const hasAuthScope = (re: RegExp) =>
            auths.some((au) => {
              const scopes = Array.isArray(au?.scopes) ? au.scopes : [];
              return scopes.some((s: unknown) => typeof s === 'string' && re.test(s));
            });
          const mintActive = (mintAuth != null && mintAuth !== '') || hasAuthScope(/mint|full/i);
          const freezeActive = (freezeAuth != null && freezeAuth !== '') || hasAuthScope(/freeze/i);
          entry.mintRenounced = !mintActive;
          entry.freezeRenounced = !freezeActive;
        }
        // Raw supply + decimals for the top-holder % computation later.
        const sup = numOrU(ti?.supply);
        if (sup != null) entry.supplyRaw = sup;
        const dec = numOrU(ti?.decimals);
        if (dec != null) entry.decimals = dec;
        // pump.fun token image lives in the on-chain metadata (IPFS via Pinata).
        // Pull from every place DAS may surface it and run each through
        // imageCandidates (multi-gateway). Order: Helius CDN (fast) → DAS image
        // link → metadata.image → first file uri. De-dupe happens in finalize().
        if (file?.cdn_uri) entry.cands.push(file.cdn_uri); // Helius-hosted CDN (fast)
        entry.cands.push(...imageCandidates(content?.links?.image));
        entry.cands.push(...imageCandidates(typeof md?.image === 'string' ? md.image : undefined));
        entry.cands.push(...imageCandidates(file?.uri));
        acc.set(id, entry);
      }
    } catch {
      /* leave unresolved */
    }
  }
}

// Excluded "holders" that are pools/programs, not real wallets — never count
// these toward holder concentration.
const NON_HOLDER_ACCOUNTS = new Set<string>([
  'So11111111111111111111111111111111111111112',
]);

/**
 * Compute the largest NON-pool holder's % of supply for ONE mint.
 *
 * One extra RPC (getTokenLargestAccounts) per mint, best-effort. The LP / pair /
 * bonding-curve token account is excluded via the DexScreener pairAddress when
 * known, plus a heuristic: the single dominant account (>50% of supply on a
 * live pair) is almost always the pool itself, so it is skipped. Returns
 * undefined on any failure or missing data — never throws.
 */
async function computeTopHolderPct(
  mint: string,
  supplyRaw: number | undefined,
  pairAddress: string | undefined
): Promise<number | undefined> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return undefined;
  const endpoint = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  try {
    let supply = supplyRaw;
    const res = await axios.post(
      endpoint,
      { jsonrpc: '2.0', id: 'top-holders', method: 'getTokenLargestAccounts', params: [mint] },
      { timeout: REQUEST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
    );
    const accounts: any[] = Array.isArray(res.data?.result?.value) ? res.data.result.value : [];
    if (accounts.length === 0) return undefined;

    // Fall back to getTokenSupply only if DAS gave us no supply.
    if (supply == null) {
      try {
        const sres = await axios.post(
          endpoint,
          { jsonrpc: '2.0', id: 'supply', method: 'getTokenSupply', params: [mint] },
          { timeout: REQUEST_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
        );
        supply = numOrU(sres.data?.result?.value?.amount);
      } catch {
        /* leave undefined */
      }
    }
    if (supply == null || supply <= 0) return undefined;

    const ranked = accounts
      .map((a) => ({ address: String(a?.address ?? ''), amount: numOrU(a?.amount) ?? 0 }))
      .filter((a) => a.address && a.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    if (ranked.length === 0) return undefined;

    for (const holder of ranked) {
      if (NON_HOLDER_ACCOUNTS.has(holder.address)) continue;
      // Explicit pool token account match (DexScreener pairAddress is the pool;
      // its associated token account often equals or is keyed off it).
      if (pairAddress && holder.address === pairAddress) continue;
      const pct = (holder.amount / supply) * 100;
      // Heuristic: a single account holding >50% on a token with a live pair is
      // almost always the LP / bonding-curve vault, not a wallet — skip it.
      if (pairAddress && pct > 50) continue;
      return Math.round(pct * 100) / 100;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Resolve up to `concurrency` async tasks at a time. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<void> {
  let idx = 0;
  const workers: Promise<void>[] = [];
  const run = async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  };
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(run());
  await Promise.all(workers);
}

// Rank a raw candidate URL by source reliability so the chain tries the most
// dependable origin first. Lower = earlier. This is the REAL fix for ordering:
// fetchDexScreener and fetchHelius append in parallel (nondeterministic order),
// so we impose a deterministic, reliability-based order here.
function sourceRank(url: string): number {
  if (/cdn\.helius/i.test(url) || /helius-rpc|hgw|helius/i.test(url)) return 0; // Helius-hosted CDN: fastest, most reliable
  if (/dd\.dexscreener\.com/i.test(url)) return 1;                              // DexScreener token CDN: canonical
  if (/dexscreener\.com/i.test(url)) return 2;                                  // DexScreener profile image
  if (/pump\.mypinata\.cloud/i.test(url)) return 3;                             // what pump.fun itself serves
  if (/\/ipfs\//i.test(url) || /ipfs/i.test(url)) return 4;                     // other IPFS gateways
  return 5;                                                                      // anything else
}

function finalize(entry: Acc): TokenMeta {
  // De-dupe raw candidates (preserve first-seen), then order by source
  // reliability (stable sort keeps insertion order within a tier).
  const rawDeduped = Array.from(
    new Set(entry.cands.filter((c): c is string => typeof c === 'string' && c.trim().length > 0))
  );
  const raw = rawDeduped
    .map((url, i) => ({ url, i }))
    .sort((a, b) => sourceRank(a.url) - sourceRank(b.url) || a.i - b.i)
    .map((x) => x.url);

  // PRIMARY candidates: route the top raw sources through the wsrv.nl image
  // proxy. This fetches server-side (no browser referrer → no DexScreener-CDN
  // 403 hotlink block, no IPFS CORS/referrer issues) and serves a fast cached
  // 64px webp. The RAW urls follow as fallbacks if the proxy itself is down.
  const proxiedTop = raw
    .slice(0, 3)
    .map((u) => proxied(u))
    .filter((u): u is string => typeof u === 'string' && u.length > 0);

  const icons = Array.from(new Set([...proxiedTop, ...raw])).slice(0, 12);
  // De-dupe links by url, cap to a sensible number.
  const seen = new Set<string>();
  const links: TokenLink[] = [];
  for (const l of entry.links) {
    if (!l?.url || seen.has(l.url)) continue;
    seen.add(l.url);
    links.push(l);
    if (links.length >= 6) break;
  }
  return {
    symbol: entry.symbol,
    name: entry.name,
    icon: icons[0],
    icons,
    links: links.length ? links : undefined,
    description: entry.description,
    pairAddress: entry.pairAddress,
    priceUsd: entry.priceUsd,
    marketCapUsd: entry.marketCapUsd,
    liquidityUsd: entry.liquidityUsd,
    volume24hUsd: entry.volume24hUsd,
    priceChange24h: entry.priceChange24h,
    buys24h: entry.buys24h,
    sells24h: entry.sells24h,
    pairCreatedAt: entry.pairCreatedAt,
    mintRenounced: entry.mintRenounced,
    freezeRenounced: entry.freezeRenounced,
    topHolderPct: entry.topHolderPct,
  };
}

export interface GetTokenMetaOptions {
  // When false, skips the extra getTokenLargestAccounts RPC per mint so a
  // large enrichment batch can stay within its request budget. Defaults on.
  includeTopHolder?: boolean;
}

export async function getTokenMeta(
  mints: string[],
  options?: GetTokenMetaOptions
): Promise<Map<string, TokenMeta>> {
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

  // ONE cheap extra signal: largest non-pool holder %. Best-effort, gated to the
  // mints being resolved THIS cycle (cache absorbs the cost), capped concurrency
  // so it never blows the request budget, and each task swallows its own errors.
  if (options?.includeTopHolder !== false) {
    const targets = toFetch.filter((m) => acc.has(m));
    await mapWithConcurrency(targets, 5, async (mint) => {
      const entry = acc.get(mint);
      if (!entry) return;
      const pct = await computeTopHolderPct(mint, entry.supplyRaw, entry.pairAddress);
      if (pct != null) entry.topHolderPct = pct;
    });
  }

  for (const mint of toFetch) {
    const entry = acc.get(mint);
    if (!entry) continue;
    const meta = finalize(entry);
    result.set(mint, meta);
    CACHE.set(mint, { meta, ts: now });
  }
  return result;
}
