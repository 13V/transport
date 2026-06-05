/**
 * INDEXER CRON ENDPOINT
 *
 * Triggered by Vercel Cron (see vercel.json) to incrementally build the
 * leaderboard. Also callable manually for testing:
 *   GET /api/cron/index
 *
 * If CRON_SECRET is set, requests must include `Authorization: Bearer <secret>`
 * (Vercel Cron sends this automatically when the env var is configured).
 */

import { NextRequest, NextResponse } from 'next/server';
import { runIndexer } from '../../../../lib/indexer/run-indexer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // allow up to 60s for an indexer run

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await runIndexer();
    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[CRON] Indexer crashed:', error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
