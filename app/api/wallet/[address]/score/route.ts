/**
 * WALLET ALL-TIME SCORE
 *
 *   GET /api/wallet/{address}/score
 *
 * Scores a wallet on its entire realized trading history: pulls the full swap
 * history and replays it through the FIFO PnL engine to return accurate all-time
 * realized PnL, deployed capital, and ROI.
 *
 * Query params:
 *   ?max=1500        transactions to scan (default 1500, clamped 100..3000)
 */

import { NextRequest, NextResponse } from 'next/server';
import { scoreWalletAllTime } from '../../../../../lib/indexer/wallet-scorer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;

  // Base58-ish sanity check — Solana addresses are 32..44 chars.
  if (!address || address.length < 32 || address.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }
  if (!process.env.HELIUS_API_KEY) {
    return NextResponse.json(
      { error: 'HELIUS_API_KEY missing — cannot fetch wallet history' },
      { status: 503 }
    );
  }

  const { searchParams } = request.nextUrl;
  const maxTxs = Math.min(Math.max(parseInt(searchParams.get('max') || '1500', 10) || 1500, 100), 3000);

  try {
    const score = await scoreWalletAllTime(address, { maxTxs });

    return NextResponse.json(score, {
      headers: { 'Cache-Control': 'public, max-age=120' },
    });
  } catch (error) {
    console.error(`[SCORE] failed for ${address}:`, error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
