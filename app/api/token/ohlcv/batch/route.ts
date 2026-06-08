/**
 * BATCHED TOKEN PRICE CANDLES (OHLCV)
 *
 *   GET /api/token/ohlcv/batch?mints=mint1,mint2,...&tf=1h
 *
 * The Live feed renders many burst cards at once. Each card wants an inline
 * price sparkline + "% since first buy". Firing one /api/token/{mint}/ohlcv
 * request per card would hammer GeckoTerminal's ~30/min rate limit instantly.
 *
 * This endpoint batches the work: it resolves each token's top pool and pulls
 * candles the SAME way the single-mint route does, but bounded by a small
 * concurrency cap and backed by a short in-process cache (keyed by mint|tf) so
 * repeated polls are cheap. Per-mint try/catch means one bad token never sinks
 * the batch. Resilient: never 5xx — failures simply drop out of `results`.
 *
 * Response: { tf, results: { [mint]: { closes, times, last } } }
 * Only mints that returned candles appear (client renders a sparkline only when
 * present — no fake data, no placeholder series).
 */

import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { getTokenMeta } from '../../../../../lib/token-meta';
import { rateLimit, clientIp } from '../../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const GT = 'https://api.geckoterminal.com/api/v2';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const MAX_MINTS = 50;
const CONCURRENCY = 5;
const CACHE_TTL_MS = 60_000;

// tf → GeckoTerminal (timeframe path, aggregate, candles to pull). Mirrors the
// single-mint route's TF map exactly.
const TF: Record<string, { timeframe: 'minute' | 'hour' | 'day'; aggregate: number; limit: number }> = {
  '5m': { timeframe: 'minute', aggregate: 5, limit: 240 }, // ~20h
  '1h': { timeframe: 'hour', aggregate: 1, limit: 168 },   // ~7d
  '1d': { timeframe: 'day', aggregate: 1, limit: 180 },    // ~6mo
};

interface Series { closes: number[]; times: number[]; last: number | null }

// In-process cache keyed by `mint|tf`. Survives across requests within the same
// serverless instance; harmless if cold-started. TTL keeps polls cheap without
// serving stale prices for long.
const cache = new Map<string, { at: number; series: Series }>();

const EMPTY: Series = { closes: [], times: [], last: null };

async function fetchSeries(mint: string, tfKey: string): Promise<Series> {
  const key = `${mint}|${tfKey}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.series;

  const tf = TF[tfKey] ?? TF['1h'];
  const remember = (series: Series): Series => {
    cache.set(key, { at: Date.now(), series });
    return series;
  };

  if (!BASE58.test(mint)) return remember(EMPTY);

  // Resolve the pool from GeckoTerminal's OWN token→pools index (top pool first),
  // exactly like the single-mint route — GT's pool id is the one it has candles
  // for. Fall back to token-meta's pairAddress only if GT has no pools.
  let pair = '';
  try {
    const pr = await axios.get(
      `${GT}/networks/solana/tokens/${mint}/pools?page=1`,
      { timeout: 12_000, headers: { Accept: 'application/json;version=20230302' } }
    );
    const pools: unknown = pr.data?.data;
    if (Array.isArray(pools) && pools.length) {
      const addr = (pools[0] as any)?.attributes?.address;
      if (typeof addr === 'string' && BASE58.test(addr)) pair = addr;
    }
  } catch {
    /* fall through to token-meta hint */
  }
  if (!BASE58.test(pair)) {
    try {
      pair = (await getTokenMeta([mint])).get(mint)?.pairAddress || '';
    } catch {
      pair = '';
    }
  }
  if (!BASE58.test(pair)) return remember(EMPTY);

  try {
    const url = `${GT}/networks/solana/pools/${pair}/ohlcv/${tf.timeframe}?aggregate=${tf.aggregate}&limit=${tf.limit}&currency=usd`;
    const res = await axios.get(url, {
      timeout: 12_000,
      headers: { Accept: 'application/json;version=20230302' },
    });
    const list: unknown = res.data?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return remember(EMPTY);

    // GeckoTerminal returns [ts(s), open, high, low, close, volume], newest-first.
    const rows = list
      .filter((r): r is number[] => Array.isArray(r) && r.length >= 6)
      .map((r) => ({ t: Number(r[0]) * 1000, c: +r[4] }))
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c))
      .sort((a, b) => a.t - b.t);

    const series: Series = {
      closes: rows.map((c) => c.c),
      times: rows.map((c) => c.t),
      last: rows.length ? rows[rows.length - 1].c : null,
    };
    return remember(series);
  } catch {
    return remember(EMPTY);
  }
}

// Bounded-concurrency map: process `items` CONCURRENCY at a time so we never
// burst GeckoTerminal beyond its rate limit. Each task is independently caught.
async function mapLimit(
  items: string[],
  limit: number,
  worker: (mint: string) => Promise<void>
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const mint = items[i++];
      try {
        await worker(mint);
      } catch {
        /* per-mint failure must never sink the batch */
      }
    }
  });
  await Promise.all(runners);
}

// Per-IP cap. This is the most expensive read (fans out up to 50 mints ×
// GeckoTerminal/Helius per call), so it's the tightest of the four. The client
// polls this ~every 3s (~20/min) for ONE param-set; we set 40/min — 2× normal
// usage so a legit poller is never blocked, while a hammering loop is cut off.
const RL_MAX = 40;

export async function GET(request: NextRequest) {
  const rl = rateLimit('ohlcv-batch', clientIp(request), RL_MAX);
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  const sp = request.nextUrl.searchParams;
  const tfKey = (sp.get('tf') || '1h').toLowerCase();
  const tf = TF[tfKey] ? tfKey : '1h';

  const headers = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' };
  const results: Record<string, Series> = {};

  try {
    const mints = Array.from(
      new Set(
        (sp.get('mints') || '')
          .split(',')
          .map((m) => m.trim())
          .filter((m) => BASE58.test(m))
      )
    ).slice(0, MAX_MINTS);

    await mapLimit(mints, CONCURRENCY, async (mint) => {
      const series = await fetchSeries(mint, tf);
      // Only include mints that actually returned candles (no fake/empty series).
      if (series.closes.length) results[mint] = series;
    });

    return NextResponse.json({ tf, results }, { headers });
  } catch {
    // Never 5xx — degrade to whatever we managed to collect.
    return NextResponse.json({ tf, results }, { headers });
  }
}
