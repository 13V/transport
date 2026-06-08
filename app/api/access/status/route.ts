/**
 * WEB PREMIUM ACCESS STATUS — GET /api/access/status?session=<web_session>
 *
 * Returns { premium: boolean, reason } for a verified web session. The server is
 * the source of truth: it resolves the verified wallet bound to the session,
 * reads its real on-chain gate-token balance, and checks it against the web
 * premium threshold (TOKEN_GATE_MIN_AMOUNT, default 500,000).
 *
 * GATE-OPEN: when TOKEN_GATE_MINT is unset, monetization isn't configured yet —
 * holdsAtLeast() returns true and everyone is premium (nothing is locked).
 *
 * Non-custodial: nothing here moves funds; it only verifies a prior wallet
 * signature binding + reads a public balance.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getVerifiedWallet, recordWalletBalance } from '../../../../lib/wallet-verify';
import {
  getTokenBalance,
  holdsAtLeast,
  isTokenGateConfigured,
  webMinAmount,
} from '../../../../lib/token-gate';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = (request.nextUrl.searchParams.get('session') || '').trim();

  // Monetization not configured → everything unlocked, stated honestly.
  if (!isTokenGateConfigured()) {
    return NextResponse.json({
      premium: true,
      reason: 'gate-open',
      configured: false,
    });
  }

  if (!session) {
    return NextResponse.json({
      premium: false,
      reason: 'no-session',
      configured: true,
    });
  }

  const verified = await getVerifiedWallet({ webSession: session }).catch(() => null);
  if (!verified?.wallet) {
    return NextResponse.json({
      premium: false,
      reason: 'wallet-not-verified',
      configured: true,
    });
  }

  const min = webMinAmount();
  const balance = await getTokenBalance(verified.wallet).catch(() => 0);
  // Cache the latest read for "balance dropped" UX elsewhere; fire-and-forget.
  void recordWalletBalance(verified.wallet, balance);

  const premium = await holdsAtLeast(verified.wallet, min);
  return NextResponse.json({
    premium,
    reason: premium ? 'ok' : 'below-threshold',
    configured: true,
    wallet: verified.wallet,
    balance,
    required: min,
  });
}
