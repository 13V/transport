/**
 * API ACCESS — PAY INFO. GET /api/access/pay
 *
 * Returns the on-chain payment instructions for buying a time-boxed API key:
 *   - treasury  : OUR public TREASURY_WALLET (funds go DIRECTLY here on-chain)
 *   - priceSol  : API_PRICE_SOL (default 1)
 *   - periodDays: API_PERIOD_DAYS (default 7)
 *   - reference : a fresh opaque reference the caller should put in the tx MEMO
 *                 (or include as a reference key) so they can prove WHICH payment
 *                 was theirs at verify time.
 *
 * NON-CUSTODIAL: we never receive or hold user funds in transit. The user sends
 * priceSol straight from their wallet to our treasury; this endpoint only hands
 * back the address + amount. Verification happens in /api/access/verify-payment.
 *
 * Honest state: when TREASURY_WALLET is unset we return { configured:false } so
 * the UI can say "monetization not yet configured" instead of inventing data.
 */

import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

export const dynamic = 'force-dynamic';

function priceSol(): number {
  const v = Number(process.env.API_PRICE_SOL);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function periodDays(): number {
  const v = Number(process.env.API_PERIOD_DAYS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 7;
}

export async function GET() {
  const treasury = (process.env.TREASURY_WALLET || '').trim();

  if (!treasury) {
    return NextResponse.json({
      configured: false,
      reason: 'treasury-not-configured',
    });
  }

  // Opaque reference the payer should drop in the memo so verify can match it.
  const reference = `api_${randomBytes(12).toString('hex')}`;

  return NextResponse.json({
    configured: true,
    treasury,
    priceSol: priceSol(),
    periodDays: periodDays(),
    reference,
    memo: reference,
    instructions:
      `Send exactly ${priceSol()} SOL to ${treasury} with the memo "${reference}", ` +
      `then click "I've paid — verify" with your transaction signature.`,
  });
}
