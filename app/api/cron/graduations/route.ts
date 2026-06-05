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
import { runGraduationScan } from '../../../../lib/indexer/run-graduation-scan';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await runGraduationScan();
    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[CRON] Graduation scan crashed:', error);
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
