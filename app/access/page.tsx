import type { Metadata } from 'next';
import AccessClient from './AccessClient';

export const metadata: Metadata = {
  title: 'Access & Membership — Smart Money',
  description:
    'Connect and verify your Solana wallet (sign-only, non-custodial) to unlock premium web access and gated Telegram alerts, or pay per period for API access.',
};

export const dynamic = 'force-dynamic';

/**
 * /access — the monetization + access-gating hub.
 *
 * All actual gating is enforced server-side; this page is the UI that lets a
 * user PROVE wallet ownership (sign a message — never moves funds) and see their
 * status across the three gates:
 *   - Web premium       (hold >= TOKEN_GATE_MIN_AMOUNT, default 500k)
 *   - Telegram alerts   (hold >= TG_GATE_MIN_AMOUNT, default 1M)
 *   - API access        (pay API_PRICE_SOL to the treasury per period)
 *
 * Honest states: when TOKEN_GATE_MINT / TREASURY_WALLET are unset the client
 * shows "monetization not yet configured" rather than inventing data.
 */
export default function AccessPage() {
  return <AccessClient />;
}
