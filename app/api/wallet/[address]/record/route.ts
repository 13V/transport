/**
 * PER-WALLET TRACK RECORD
 *
 *   GET /api/wallet/{address}/record            → getWalletRecord(address, 90)
 *   GET /api/wallet/{address}/record?days=30    → window in days (clamped 1..365)
 *
 * A wallet's VERIFIABLE measured calls: median forward return + hit rate @1h/@24h,
 * best/worst call, and recent measured bursts the wallet participated in — all
 * from REAL price history (lib/indexer/wallet-record.ts). Legs with no
 * measurement are excluded, never faked; `n` is always returned (0 when none).
 *
 * Read-only and public. Short edge cache (these aggregates only move on the
 * measure cron's cadence). Degrades to an empty-but-shaped record on any error.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWalletRecord } from '../../../../../lib/indexer/wallet-record';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CACHE = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;

  // Base58-ish sanity check — Solana addresses are 32..44 chars.
  if (
    !address ||
    address.length < 32 ||
    address.length > 44 ||
    !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)
  ) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  const raw = Number(request.nextUrl.searchParams.get('days'));
  const days = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 365)) : 90;

  try {
    const record = await getWalletRecord(address, days);
    return NextResponse.json(record, { headers: CACHE });
  } catch (error) {
    console.error('[WALLET-RECORD] route crashed:', error);
    // Degrade to an empty-but-shaped payload so the profile never breaks.
    return NextResponse.json(
      {
        address,
        n: 0,
        medianRet1h: null,
        hitRate1h: null,
        medianRet24h: null,
        hitRate24h: null,
        bestCall: null,
        worstCall: null,
        recentCalls: [],
        windowDays: days,
      },
      { headers: CACHE }
    );
  }
}
