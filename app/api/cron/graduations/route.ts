/**
 * GRADUATION SCAN CRON ENDPOINT
 *
 * Captures graduated pump.fun -> PumpSwap coins in full (every swap, every
 * wallet) and enqueues those wallets for deep-scan analysis. Pairs with
 * /api/cron/seed-wallets, which drains the queue into accurate verified scores.
 *
 *   GET /api/cron/graduations
 *
 * CRON_SECRET-protected when set (Vercel/GitHub Action sends it automatically).
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { runGraduationScan } from '../../../../lib/indexer/run-graduation-scan';

export const dynamic = 'force-dynamic';

/**
 * Cron auth — FAILS CLOSED. Returns true (= reject) when CRON_SECRET is unset OR
 * the Authorization header does not match `Bearer <secret>`. Constant-time,
 * length-guarded compare.
 */
function cronAuthFails(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = request.headers.get('authorization') ?? '';
  const a = Buffer.from(auth);
  const b = Buffer.from(`Bearer ${secret}`);
  if (a.length !== b.length) return true;
  return !timingSafeEqual(a, b);
}

export const maxDuration = 60;

function clampParam(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Per-call overrides so the cron driver can dial bulk-ingest volume.
  //   ?maxCoins=8   graduated coins to fully scan this call (1..40)
  //   ?maxTxs=3000  history depth per coin (500..5000)
  //   ?shards=N     total parallel jobs (1..16); >1 partitions coins by mint-hash
  //   ?shard=i      this job's shard index (0..shards-1)
  const sp = request.nextUrl.searchParams;
  const opts: { maxCoins?: number; maxTxsPerCoin?: number; shard?: number; shards?: number } = {};
  const maxCoins = clampParam(sp.get('maxCoins'), 1, 40);
  const maxTxs = clampParam(sp.get('maxTxs'), 500, 5000);
  if (maxCoins !== undefined) opts.maxCoins = maxCoins;
  if (maxTxs !== undefined) opts.maxTxsPerCoin = maxTxs;

  const shards = clampParam(sp.get('shards'), 1, 16);
  if (shards !== undefined) {
    opts.shards = shards;
    const shard = clampParam(sp.get('shard'), 0, shards - 1);
    if (shard !== undefined) opts.shard = shard;
  }

  try {
    const result = await runGraduationScan(opts);
    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[CRON] Graduation scan crashed:', error);
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
