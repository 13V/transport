/**
 * CHAIN DISCOVERY CRON ENDPOINT
 *
 * Follows our proven winners into the coins they're buying and captures the
 * co-traders — compounding the smart-wallet set from quality seeds. Ported from
 * gmgn's chain-discovery loop. Pairs with the deep-scan worker that verifies the
 * captured wallets.
 *
 *   GET /api/cron/chain-discovery
 */

import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import { runChainDiscovery } from '../../../../lib/indexer/run-chain-discovery';

export const dynamic = 'force-dynamic';

export const maxDuration = 60;

/** Parse + clamp an optional integer query param; undefined if absent/invalid. */
function clampParam(raw: string | null, min: number, max: number): number | undefined {
  if (raw == null) return undefined;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v)) return undefined;
  return Math.min(Math.max(v, min), max);
}

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Optional per-call overrides (clamped). The drive is cron-job.org, whose free
  // tier aborts the connection at 30s — pass ?timeBudgetMs=24000 to return before
  // then so the job logs a clean success instead of a (harmless) timeout.
  const sp = request.nextUrl.searchParams;
  const opts: { maxWinners?: number; maxCoins?: number; maxTxsPerCoin?: number; timeBudgetMs?: number } = {};
  const maxWinners = clampParam(sp.get('maxWinners'), 1, 100);
  const maxCoins = clampParam(sp.get('maxCoins'), 1, 40);
  const maxTxsPerCoin = clampParam(sp.get('maxTxsPerCoin'), 100, 5000);
  const timeBudgetMs = clampParam(sp.get('timeBudgetMs'), 5_000, 58_000);
  if (maxWinners !== undefined) opts.maxWinners = maxWinners;
  if (maxCoins !== undefined) opts.maxCoins = maxCoins;
  if (maxTxsPerCoin !== undefined) opts.maxTxsPerCoin = maxTxsPerCoin;
  if (timeBudgetMs !== undefined) opts.timeBudgetMs = timeBudgetMs;

  try {
    const result = await runChainDiscovery(opts);
    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[CRON] Chain discovery crashed:', error);
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
