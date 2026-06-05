/**
 * CHAIN DISCOVERY CRON ENDPOINT
 *
 * Follows our proven winners into the coins they're buying and captures the
 * co-traders — compounding the smart-wallet set from quality seeds. Ported from
 * gmgn's chain-discovery loop. Pairs with the deep-scan worker that verifies the
 * captured wallets.
 *
 *   GET /api/cron/chain-discovery
 */

import { NextRequest, NextResponse } from 'next/server';
import { runChainDiscovery } from '../../../../lib/indexer/run-chain-discovery';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const result = await runChainDiscovery();
    return NextResponse.json(result, {
      status: result.ok ? 200 : 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[CRON] Chain discovery crashed:', error);
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
