/* =========================================================================
   GATE BALANCE CHECK — GET /api/gate/balance?address=<wallet>

   Server-side gate-token balance read for the client `useGate` hook. Keeps the
   RPC/key on the server and returns just the verdict.

   Behaviour:
     - Gating OFF (flag off or no mint): passthrough { isPro: true } — nothing
       is gated today, regardless of address. Production-safe no-op.
     - Gating ON: real on-chain balance via lib/gating/balance.ts; isPro is
       balance >= NEXT_PUBLIC_GATE_MIN_BALANCE. Errors degrade to balance 0.
   ========================================================================= */

import { NextRequest, NextResponse } from 'next/server';
import { isGatingEnabled, gatingConfig } from '../../../../lib/gating/config';
import { checkGateAccess } from '../../../../lib/gating/balance';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Flag off / no mint → everything unlocked. Don't even read the chain.
  if (!isGatingEnabled()) {
    return NextResponse.json(
      { gatingEnabled: false, isPro: true, balance: null },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const address = req.nextUrl.searchParams.get('address')?.trim() || '';
  if (!address) {
    return NextResponse.json(
      { gatingEnabled: true, isPro: false, balance: 0, error: 'missing address' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const { balance, isPro } = await checkGateAccess(address);

  return NextResponse.json(
    {
      gatingEnabled: true,
      isPro,
      balance,
      minBalance: gatingConfig.minBalance,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
