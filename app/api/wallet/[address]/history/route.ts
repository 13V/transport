/**
 * WALLET LEADERBOARD HISTORY
 *
 *   GET /api/wallet/{address}/history?days=90
 *
 * Returns the wallet's daily leaderboard snapshots (rank/score/ROI/PnL over
 * time), oldest-to-newest, so the client can chart its trajectory and detect
 * rising wallets. Read-only and public.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWalletHistory } from '../../../../../lib/indexer/snapshots';

export const dynamic = 'force-dynamic';

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

  const daysParam = parseInt(request.nextUrl.searchParams.get('days') || '90', 10);
  const days = Number.isFinite(daysParam) ? Math.max(1, Math.min(daysParam, 3650)) : 90;

  try {
    const result = await getWalletHistory(address, days);
    return NextResponse.json(
      { address, ...result },
      { headers: { 'Cache-Control': 'public, max-age=300' } }
    );
  } catch (error) {
    console.error('[HISTORY] Failed to read wallet history:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
