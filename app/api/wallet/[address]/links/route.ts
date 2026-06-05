/**
 * WALLET FUNDING LINKS (cluster view)
 *
 *   GET /api/wallet/{address}/links
 *
 * Shows the funding graph around a wallet — who it funded, and who funded it.
 * This is the "track them forever" surface: a fresh wallet funded by a known
 * smart wallet is almost certainly the same trader.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  if (!address || address.length < 32 || address.length > 44) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }

  const supabase = getSupabase();

  // Wallets this address funded, and wallets that funded it.
  const [funded, fundedBy] = await Promise.all([
    supabase
      .from('wallet_links')
      .select('target, amount_sol, transfers, first_seen, last_seen')
      .eq('source', address)
      .order('amount_sol', { ascending: false })
      .limit(200),
    supabase
      .from('wallet_links')
      .select('source, amount_sol, transfers, first_seen, last_seen')
      .eq('target', address)
      .order('amount_sol', { ascending: false })
      .limit(50),
  ]);

  if (funded.error || fundedBy.error) {
    return NextResponse.json(
      { error: funded.error?.message || fundedBy.error?.message },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      address,
      funded: (funded.data ?? []).map((r: any) => ({
        wallet: r.target,
        amountSol: Number(r.amount_sol),
        transfers: r.transfers,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
      })),
      fundedBy: (fundedBy.data ?? []).map((r: any) => ({
        wallet: r.source,
        amountSol: Number(r.amount_sol),
        transfers: r.transfers,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
      })),
    },
    { headers: { 'Cache-Control': 'public, max-age=120' } }
  );
}
