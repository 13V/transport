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

  const empty = (extra: Record<string, unknown> = {}) =>
    NextResponse.json(
      { mint, tf: tfKey, candles: [], closes: [], times: [], ...extra },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } }
    );

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
  if (!BASE58.test(pair)) return empty({ error: 'no pool' });

  try {
    const url = `${GT}/networks/solana/pools/${pair}/ohlcv/${tf.timeframe}?aggregate=${tf.aggregate}&limit=${tf.limit}&currency=usd`;
    const res = await axios.get(url, {
      timeout: 12_000,
      headers: { Accept: 'application/json;version=20230302' },
    });
    const list: unknown = res.data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return empty({ pair });

    // GeckoTerminal returns [ts(s), open, high, low, close, volume], newest-first.
    const candles: Candle[] = list
      .filter((r): r is number[] => Array.isArray(r) && r.length >= 6)
      .map((r) => ({ t: Number(r[0]) * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c))
      .sort((a, b) => a.t - b.t);

    return NextResponse.json(
      {
        mint,
        pair,
        tf: tfKey,
        candles,
        closes: candles.map((c) => c.c),
        times: candles.map((c) => c.t),
        last: candles.length ? candles[candles.length - 1].c : null,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } }
    );
  } catch {
    return empty({ pair });
  }
}
