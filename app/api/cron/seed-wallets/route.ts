/**
 * SEED-WALLET INDEXER CRON ENDPOINT
 *
 * Deep-scans the curated alpha wallet list (wallet-first) and upserts their
 * stats into the leaderboard, flagged as seeded. Triggered by Vercel Cron (see
 * vercel.json) and callable manually for testing:
 *   GET /api/cron/seed-wallets
 *
 * If CRON_SECRET is set, requests must include `Authorization: Bearer <secret>`
 * (Vercel Cron sends this automatically when the env var is configured).
 *
 * Per-call tuning (query overrides, clamped to safe ranges):
 *   ?maxWallets=30      wallets to deep-scan this call (1..60)
 *   ?maxTxs=500         max swap txs fetched per wallet (50..1000)
 *   ?timeBudgetMs=50000 wall-clock budget for the run (5000..58000)
 *   ?shards=6&shard=0   parallel draining: each shard scans a disjoint subset
 *                       of the backlog (run N jobs with shard=0..N-1)
 * These let the cron DRIVER dial throughput without touching Vercel env vars.
 * Omitting a param keeps the existing code/env default in runSeedIndexer.
 *
 * The JSON response is the SeedIndexerResult; `walletsProcessed` lets the driver
 * detect an empty backlog (value 0) and stop looping early.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import {
  runSeedIndexer,
  type SeedIndexerOptions,
} from '../../../../lib/indexer/run-seed-indexer';

export const dynamic = 'force-dynamic';

export const maxDuration = 60; // allow up to 60s for a seed run

/** Parse + clamp an optional integer query param; undefined if absent/invalid. */
function clampParam(
  raw: string | null,
  min: number,
  max: number
): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Optional per-call overrides, clamped so a bad/hostile value can't blow the
  // Helius budget or exceed the 60s Vercel function ceiling.
  const sp = request.nextUrl.searchParams;
  const opts: SeedIndexerOptions = {};
  const maxWallets = clampParam(sp.get('maxWallets'), 1, 60);
  const maxTxs = clampParam(sp.get('maxTxs'), 50, 1000);
  const timeBudgetMs = clampParam(sp.get('timeBudgetMs'), 5_000, 58_000);
  if (maxWallets !== undefined) opts.maxWallets = maxWallets;
  if (maxTxs !== undefined) opts.maxTxsPerWallet = maxTxs;
  if (timeBudgetMs !== undefined) opts.timeBudgetMs = timeBudgetMs;
  const shards = clampParam(sp.get('shards'), 1, 24);
  const shard = clampParam(sp.get('shard'), 0, (shards ?? 1) - 1);
  if (shards !== undefined) opts.shards = shards;
  if (shard !== undefined) opts.shard = shard;

  try {
    const result = await runSeedIndexer(opts);
    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[CRON] Seed indexer crashed:', error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
