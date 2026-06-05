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
 */

import { NextRequest, NextResponse } from 'next/server';
import { runSeedIndexer } from '../../../../lib/indexer/run-seed-indexer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // allow up to 60s for a seed run

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await runSeedIndexer();
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
