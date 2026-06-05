/**
 * HELIUS DEBUG ENDPOINT
 *
 * Diagnostic only — shows exactly what the Helius Enhanced Transactions API
 * returns for a token, so we can see why the indexer parses 0 trades.
 *
 *   GET /api/debug/helius              -> uses the first token from the universe
 *   GET /api/debug/helius?mint=<mint>  -> probes a specific mint
 *
 * Reports, for the address-based SWAP query:
 *   - HTTP status + raw transaction count (with and without the type=SWAP filter)
 *   - for the first few txs: presence/shape of events.swap, native legs, and
 *     the mints seen in tokenInputs/tokenOutputs
 *
 * No secrets are returned.
 */

import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { getTokenUniverse } from '../../../../lib/indexer/token-universe';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function probe(url: string, params: Record<string, unknown>) {
  try {
    const { data, status } = await axios.get(url, { params, timeout: 20000 });
    const arr = Array.isArray(data) ? data : [];
    return { status, count: arr.length, txs: arr };
  } catch (err) {
    const status = (err as any)?.response?.status ?? null;
    const body = (err as any)?.response?.data;
    return {
      status,
      count: 0,
      txs: [] as any[],
      error: (err as Error).message,
      body: typeof body === 'string' ? body.slice(0, 300) : body,
    };
  }
}

function summarizeSwap(tx: any) {
  const swap = tx?.events?.swap;
  return {
    type: tx?.type,
    source: tx?.source,
    feePayer: tx?.feePayer,
    hasSwapEvent: Boolean(swap),
    swapKeys: swap ? Object.keys(swap) : [],
    nativeInput: swap?.nativeInput?.amount ?? null,
    nativeOutput: swap?.nativeOutput?.amount ?? null,
    tokenInputMints: (swap?.tokenInputs ?? []).map((t: any) => t?.mint),
    tokenOutputMints: (swap?.tokenOutputs ?? []).map((t: any) => t?.mint),
    innerSwapCount: Array.isArray(swap?.innerSwaps) ? swap.innerSwaps.length : 0,
  };
}

/** Dump the transfer-level fields the new parser will rely on. */
function rawTransfers(tx: any) {
  return {
    type: tx?.type,
    source: tx?.source,
    feePayer: tx?.feePayer,
    signature: tx?.signature,
    tokenTransfers: (tx?.tokenTransfers ?? []).map((t: any) => ({
      fromUserAccount: t?.fromUserAccount,
      toUserAccount: t?.toUserAccount,
      mint: t?.mint,
      tokenAmount: t?.tokenAmount,
    })),
    nativeTransfers: (tx?.nativeTransfers ?? []).map((n: any) => ({
      fromUserAccount: n?.fromUserAccount,
      toUserAccount: n?.toUserAccount,
      amount: n?.amount,
    })),
  };
}

export async function GET(request: NextRequest) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) {
    return NextResponse.json({ error: 'HELIUS_API_KEY missing' }, { status: 500 });
  }

  let mint = request.nextUrl.searchParams.get('mint') ?? '';
  let universeNote: string | undefined;
  if (!mint) {
    const universe = await getTokenUniverse(5);
    mint = universe[0]?.mint ?? '';
    universeNote = `universe returned ${universe.length} tokens; probing first`;
  }
  if (!mint) {
    return NextResponse.json({ error: 'no mint to probe (universe empty)' }, { status: 500 });
  }

  const path = `/v0/addresses/${mint}/transactions`;
  const hosts = {
    legacy: `https://api.helius.xyz${path}`,
    current: `https://api-mainnet.helius-rpc.com${path}`,
  };

  // Probe BOTH hosts so we can tell a host problem from a bad-key problem.
  const legacy = await probe(hosts.legacy, { 'api-key': key, type: 'SWAP', limit: 100 });
  const current = await probe(hosts.current, { 'api-key': key, type: 'SWAP', limit: 100 });

  return NextResponse.json({
    buildMarker: 'raw-transfers-v3',
    mint,
    universeNote,
    keyLength: key.length,
    keyTail: key.slice(-4),
    legacyHost: {
      url: hosts.legacy,
      status: legacy.status,
      count: legacy.count,
      error: (legacy as any).error,
      body: (legacy as any).body,
      sampleSwaps: legacy.txs.slice(0, 2).map(summarizeSwap),
    },
    currentHost: {
      url: hosts.current,
      status: current.status,
      count: current.count,
      error: (current as any).error,
      body: (current as any).body,
      sampleSwaps: current.txs.slice(0, 2).map(summarizeSwap),
      rawTransferSamples: current.txs.slice(0, 3).map(rawTransfers),
    },
  });
}
