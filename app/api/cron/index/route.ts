/**
 * INDEXER CRON ENDPOINT
 *
 * Triggered by Vercel Cron (see vercel.json) to incrementally build the
 * leaderboard. Also callable manually for testing:
 *   GET /api/cron/index
 *
 * If CRON_SECRET is set, requests must include `Authorization: Bearer <secret>`
 * (Vercel Cron sends this automatically when the env var is configured).
 *
 * Per-call tuning (query override, clamped): ?maxTokens=15 (1..60). Lets the
 * cron driver feed the deep-scan backlog faster without changing Vercel env
 * vars. Omitting it keeps the existing code/env default in runIndexer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import {
  runIndexer,
  type IndexerOptions,
} from '../../../../lib/indexer/run-indexer';

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

export const maxDuration = 60; // allow up to 60s for an indexer run

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

  const opts: IndexerOptions = {};
  const maxTokens = clampParam(request.nextUrl.searchParams.get('maxTokens'), 1, 60);
  if (maxTokens !== undefined) opts.maxTokens = maxTokens;

  try {
    const result = await runIndexer(opts);
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
