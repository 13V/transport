/**
 * WALLET ENTITY CLUSTER
 *
 *   GET /api/wallet/{address}/cluster
 *
 * Surfaces a trader's whole on-chain identity: every wallet linked to this one
 * through the SOL funding graph, treated as a single entity (connected
 * component). For each member we attach its verified ROI from wallet_stats so a
 * caller can see the entity's performance across all its wallets at once.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getClusterFor } from '../../../../../lib/indexer/clusters';
import { getSupabase, isSupabaseConfigured } from '../../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';

interface MemberStat {
  wallet: string;
  roiPct: number | null;
  verified: boolean;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;

  // Base58-ish sanity check — Solana addresses are 32..44 chars, no 0/O/I/l.
  if (
    !address ||
    address.length < 32 ||
    address.length > 44 ||
    !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)
  ) {
    return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }

  const { members, edges } = await getClusterFor(address);

  // Attach verified ROI for every member in one batched query.
  const statsByWallet = new Map<string, MemberStat>();
  if (members.length > 0) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('wallet_stats')
      .select('wallet, roi_pct, verified')
      .in('wallet', members);

    if (error) {
      console.error(`[CLUSTER] wallet_stats lookup failed: ${error.message}`);
    } else {
      for (const row of data ?? []) {
        const wallet = (row as any).wallet as string;
        statsByWallet.set(wallet, {
          wallet,
          roiPct: (row as any).roi_pct == null ? null : Number((row as any).roi_pct),
          verified: Boolean((row as any).verified),
        });
      }
    }
  }

  const memberStats: MemberStat[] = members.map(
    (wallet) =>
      statsByWallet.get(wallet) ?? { wallet, roiPct: null, verified: false }
  );

  return NextResponse.json(
    {
      address,
      memberCount: members.length,
      members: memberStats,
      edges,
    },
    { headers: { 'Cache-Control': 'public, max-age=120' } }
  );
}
