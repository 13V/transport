/**
 * HELIUS ENHANCED-WEBHOOK INGESTION ENDPOINT
 *
 * Real-time (sub-second) trade ingestion for our subscribed smart wallets.
 * Helius POSTs a JSON ARRAY of enriched transactions here; we parse the
 * SOL<->token swaps and upsert them into `trades` so the Live feed / alerts
 * fire within seconds. This replaces polling for the subscribed set.
 *
 * SECURITY — FAILS CLOSED. This is a PUBLIC POST endpoint that writes to
 * `trades`. Without auth, anyone could inject fake trades → fake bursts. So:
 *   - HELIUS_WEBHOOK_SECRET MUST be set, AND
 *   - the request's `Authorization` header MUST equal it exactly
 *     (Helius sends the configured authHeader value verbatim).
 * If the env is unset OR the header mismatches → 401. No exceptions.
 *
 * RESILIENCE: never 5xx on a single bad tx (Helius retries slow/failing
 * webhooks). We parse defensively, upsert in chunks, and always return fast.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { parseHeliusSwaps } from '../../../../lib/helius/parse-swap';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CHUNK = 500;

export async function POST(request: NextRequest) {
  // ---- Auth: FAIL CLOSED. ----
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) {
    // No secret configured → refuse to accept any write. Unauthenticated
    // writes to `trades` would let anyone fabricate trades.
    return NextResponse.json(
      { error: 'Webhook secret not configured' },
      { status: 401 }
    );
  }
  const auth = request.headers.get('authorization');
  if (auth !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ---- Parse body (expected: array of enriched txs). ----
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    // Malformed JSON: 200 no-op so Helius doesn't hammer retries.
    return NextResponse.json({ ok: true, parsed: 0, written: 0 });
  }

  // We trust the auth header + that Helius only sends our subscribed
  // addresses, so a subscribed set isn't required — pass undefined.
  const rows = parseHeliusSwaps(payload, undefined);
  const parsed = rows.length;

  // If Supabase isn't configured, no-op (don't crash, don't fabricate).
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, parsed, written: 0 });
  }

  if (parsed === 0) {
    return NextResponse.json({ ok: true, parsed: 0, written: 0 });
  }

  const supabase = getSupabase();
  let written = 0;

  // Chunked upsert mirroring lib/indexer/run-indexer.ts. Dedup via the unique
  // constraint (tx_hash, wallet, token_mint, trade_type) — ignoreDuplicates so
  // the same tx delivered twice (Helius retries) is idempotent.
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      const { error } = await supabase
        .from('trades')
        .upsert(chunk, {
          onConflict: 'tx_hash,wallet,token_mint,trade_type',
          ignoreDuplicates: true,
        });
      if (error) {
        console.error('[HELIUS WEBHOOK] upsert trades failed:', error.message);
        continue; // keep other chunks; never 5xx
      }
      written += chunk.length;
    } catch (err) {
      console.error('[HELIUS WEBHOOK] upsert threw:', (err as Error).message);
      continue;
    }
  }

  return NextResponse.json({ ok: true, parsed, written });
}
