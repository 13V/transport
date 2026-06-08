/**
 * TOKEN PRICE CANDLES (OHLCV)
 *
 *   GET /api/token/{mint}/ohlcv?tf=1h&pair={poolAddress}
 *
 * Pulls real price history from GeckoTerminal's free public OHLCV API for the
 * token's highest-liquidity Solana pool, so we can render our OWN price chart
 * instead of embedding DexScreener's iframe (which ad-blockers routinely break).
 *
 * tf: '5m' | '1h' | '1d' (default '1h'). `pair` (the pool address) is optional —
 * if omitted we resolve it from token metadata. Resilient: returns an empty
 * series (never 5xx) so the chart degrades to an empty state, never a crash.
 */

import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { getTokenMeta } from '../../../../../lib/token-meta';
import { rateLimit, clientIp } from '../../../../../lib/rate-limit';
import { getSupabase, isSupabaseConfigured } from '../../../../../lib/supabase-client';

export const revalidate = 60;
export const maxDuration = 30;

const GT = 'https://api.geckoterminal.com/api/v2';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// tf → GeckoTerminal (timeframe path, aggregate, candles to pull)
const TF: Record<string, { timeframe: 'minute' | 'hour' | 'day'; aggregate: number; limit: number }> = {
  '5m': { timeframe: 'minute', aggregate: 5, limit: 240 }, // ~20h
  '1h': { timeframe: 'hour', aggregate: 1, limit: 168 },   // ~7d
  '1d': { timeframe: 'day', aggregate: 1, limit: 180 },    // ~6mo
};

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

// Bucket width (ms) per timeframe for the on-chain fallback series, mirroring the
// GeckoTerminal aggregate above so the fallback's granularity matches the live tf.
const TF_BUCKET_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};
const ONCHAIN_MAX_ROWS = 4000;

/**
 * ON-CHAIN FALLBACK SERIES: when GeckoTerminal has no candles for a pool (fresh
 * pre-graduation pump.fun token), build a minimal close-price series straight
 * from the ingested `trades` table (trades.price = solAmount/amount, SOL/token).
 * Same on-chain price source the burst pipeline uses for fresh tokens
 * (lib/indexer/live-bursts firstBuyPriceSol/lastBuyPriceSol). Trades are bucketed
 * to the requested tf and each bucket's close is its last priced trade — so a
 * fresh token renders a REAL price line instead of "No price history yet".
 *
 * Returns null on any failure / no data, so the caller degrades to the empty
 * state exactly as before. Never throws.
 */
async function onchainSeries(
  mint: string,
  tfKey: string
): Promise<{ closes: number[]; times: number[]; last: number | null } | null> {
  if (!isSupabaseConfigured()) return null;
  const bucketMs = TF_BUCKET_MS[tfKey] ?? TF_BUCKET_MS['1h'];
  try {
    const supabase = getSupabase();
    // Newest-first so a hot token's cap keeps the freshest trades; we re-sort
    // ascending in memory below. Rides the trades(token_mint, block_time) index.
    const { data, error } = await supabase
      .from('trades')
      .select('price, block_time')
      .eq('token_mint', mint)
      .order('block_time', { ascending: false })
      .limit(ONCHAIN_MAX_ROWS);
    if (error || !data || data.length === 0) return null;

    // Last priced trade per time bucket (close), ascending by time.
    const closeByBucket = new Map<number, number>();
    for (const r of data as { price: unknown; block_time: unknown }[]) {
      const price = Number(r.price);
      const ts = r.block_time ? new Date(r.block_time as string).getTime() : NaN;
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ts)) continue;
      const bucket = Math.floor(ts / bucketMs) * bucketMs;
      // data is newest-first, so the FIRST row we see for a bucket is its latest
      // (close) trade — only set if not already present.
      if (!closeByBucket.has(bucket)) closeByBucket.set(bucket, price);
    }
    if (closeByBucket.size === 0) return null;

    const buckets = Array.from(closeByBucket.keys()).sort((a, b) => a - b);
    const closes = buckets.map((b) => closeByBucket.get(b) as number);
    // AreaChart needs ≥2 points to draw a line; a single trade-bucket would render
    // nothing useful, so duplicate it into a flat 2-point series at the same price.
    if (closes.length === 1) {
      return { closes: [closes[0], closes[0]], times: [buckets[0], buckets[0] + bucketMs], last: closes[0] };
    }
    return { closes, times: buckets, last: closes[closes.length - 1] };
  } catch {
    return null;
  }
}

// Per-IP cap: 60/min. A single-mint chart resolves one pool + one OHLCV pull on
// GeckoTerminal, so it's lighter than the batch route. 60/min leaves generous
// headroom for a user opening several token charts while still capping abuse.
const RL_MAX = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mint: string }> }
) {
  const rl = rateLimit('ohlcv-single', clientIp(request), RL_MAX);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  const { mint } = await params;
  const sp = request.nextUrl.searchParams;
  const tfKey = (sp.get('tf') || '1h').toLowerCase();
  const tf = TF[tfKey] ?? TF['1h'];

  const HDRS = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };
  const empty = (extra: Record<string, unknown> = {}) =>
    NextResponse.json(
      { mint, tf: tfKey, candles: [], closes: [], times: [], ...extra },
      { headers: HDRS }
    );

  // When GeckoTerminal has no candles, fall back to an on-chain trade-price
  // series so fresh pump.fun tokens still render a REAL price line instead of an
  // empty "No price history" state. Falls through to `empty` when there are no
  // on-chain trades either. `source: 'onchain'` lets the client label it.
  const emptyOrOnchain = async (extra: Record<string, unknown> = {}) => {
    const oc = await onchainSeries(mint, tfKey);
    if (oc && oc.closes.length >= 2) {
      return NextResponse.json(
        { mint, tf: tfKey, candles: [], closes: oc.closes, times: oc.times, last: oc.last, source: 'onchain', ...extra },
        { headers: HDRS }
      );
    }
    return empty(extra);
  };

  if (!mint || !BASE58.test(mint)) return empty({ error: 'invalid mint' });

  // Resolve the pool address from GeckoTerminal's OWN token→pools index — this is
  // the key fix: DexScreener's pair address often isn't the same id GeckoTerminal
  // uses for pump pools, so OHLCV-by-DexScreener-pair returns empty. Asking GT for
  // the token's top pool guarantees a pool id GT actually has candles for. We fall
  // back to an explicit ?pair= / token-meta pair only if GT has no pools.
  let pair = '';
  try {
    const pr = await axios.get(
      `${GT}/networks/solana/tokens/${mint}/pools?page=1`,
      { timeout: 12_000, headers: { Accept: 'application/json;version=20230302' } }
    );
    const pools: unknown = pr.data?.data;
    if (Array.isArray(pools) && pools.length) {
      // GT returns pools ranked (top by reserve/liquidity first).
      const addr = (pools[0] as any)?.attributes?.address;
      if (typeof addr === 'string' && BASE58.test(addr)) pair = addr;
    }
  } catch {
    /* fall through to the hints below */
  }
  if (!BASE58.test(pair)) {
    const hint = (sp.get('pair') || '').trim();
    if (BASE58.test(hint)) pair = hint;
  }
  if (!BASE58.test(pair)) {
    try {
      pair = (await getTokenMeta([mint])).get(mint)?.pairAddress || '';
    } catch {
      pair = '';
    }
  }
  // No GeckoTerminal pool at all (fresh token) — try the on-chain fallback.
  if (!BASE58.test(pair)) return emptyOrOnchain({ error: 'no pool' });

  try {
    const url = `${GT}/networks/solana/pools/${pair}/ohlcv/${tf.timeframe}?aggregate=${tf.aggregate}&limit=${tf.limit}&currency=usd`;
    const res = await axios.get(url, {
      timeout: 12_000,
      headers: { Accept: 'application/json;version=20230302' },
    });
    const list: unknown = res.data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return emptyOrOnchain({ pair });

    // GeckoTerminal returns [ts(s), open, high, low, close, volume], newest-first.
    const candles: Candle[] = list
      .filter((r): r is number[] => Array.isArray(r) && r.length >= 6)
      .map((r) => ({ t: Number(r[0]) * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c))
      .sort((a, b) => a.t - b.t);

    // GeckoTerminal returned a pool but no candles yet (just-created pool) — fall
    // back to the on-chain trade series so the chart still shows something real.
    if (candles.length < 2) return emptyOrOnchain({ pair });

    return NextResponse.json(
      {
        mint,
        pair,
        tf: tfKey,
        candles,
        closes: candles.map((c) => c.c),
        times: candles.map((c) => c.t),
        last: candles.length ? candles[candles.length - 1].c : null,
        source: 'geckoterminal',
      },
      { headers: HDRS }
    );
  } catch {
    return emptyOrOnchain({ pair });
  }
}
