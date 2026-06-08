/**
 * WATCHLIST STORE
 *
 * Server-side, cross-device watchlist of wallet addresses, keyed by an opaque
 * `owner` identity. The owner is a stable per-device UUID generated client-side
 * (see lib/useWatchlist.ts, localStorage key `sm_owner_id`); it can later be
 * swapped for a connected wallet address (token-gating identity) with no schema
 * or contract change.
 *
 *   GET    /api/watchlist?owner=<id>          → { owner, addresses: string[] }
 *   POST   /api/watchlist  { owner, address } → { ok, address }   (upsert)
 *   DELETE /api/watchlist  { owner, address } → { ok }            (remove)
 *
 * Degrades gracefully: when Supabase isn't configured, GET returns an empty set
 * and writes are no-ops (HTTP 200) so the client falls back to localStorage-only
 * exactly as before — the UI never breaks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../lib/supabase-client';
import { rateLimit, clientIp } from '../../../lib/rate-limit';

// Writes — never cache.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// Per-IP write cap (near-term abuse mitigation; identity is a self-asserted
// owner id, so the IP limiter is the cheap guardrail on the mutating path).
const WRITE_RL_MAX = 60;

/** Returns a 429 response when the per-IP write budget is exhausted, else null. */
function writeRateLimited(request: NextRequest): NextResponse | null {
  const rl = rateLimit('watchlist-write', clientIp(request), WRITE_RL_MAX);
  if (rl.ok) return null;
  return NextResponse.json(
    { error: 'Rate limit exceeded' },
    { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfter) } }
  );
}

// base58-ish: Solana addresses are 32-44 chars from the base58 alphabet
// (no 0, O, I, l). Owner ids are UUIDs or, later, wallet addresses — keep them
// to a sane length / charset to reject junk without over-fitting.
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OWNER_RE = /^[A-Za-z0-9_-]{8,64}$/;

function isValidAddress(v: unknown): v is string {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

function isValidOwner(v: unknown): v is string {
  return typeof v === 'string' && OWNER_RE.test(v);
}

/** GET — the owner's watched addresses. */
export async function GET(request: NextRequest) {
  const owner = request.nextUrl.searchParams.get('owner');
  if (!isValidOwner(owner)) {
    return NextResponse.json({ error: 'Invalid owner' }, { status: 400, headers: NO_STORE });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ owner, addresses: [] }, { headers: NO_STORE });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('watchlists')
    .select('address')
    .eq('owner_id', owner)
    .order('created_at', { ascending: true });

  if (error) {
    // Table missing / pre-migration → behave as unconfigured rather than 500.
    return NextResponse.json({ owner, addresses: [] }, { headers: NO_STORE });
  }

  const addresses = (data ?? [])
    .map((r: { address: string }) => r.address)
    .filter(isValidAddress);
  return NextResponse.json({ owner, addresses }, { headers: NO_STORE });
}

async function readBody(request: NextRequest): Promise<{ owner: unknown; address: unknown }> {
  try {
    const body = await request.json();
    return { owner: body?.owner, address: body?.address };
  } catch {
    return { owner: undefined, address: undefined };
  }
}

/** POST — upsert one address for the owner. */
export async function POST(request: NextRequest) {
  const limited = writeRateLimited(request);
  if (limited) return limited;

  const { owner, address } = await readBody(request);
  if (!isValidOwner(owner) || !isValidAddress(address)) {
    return NextResponse.json({ error: 'Invalid owner or address' }, { status: 400, headers: NO_STORE });
  }

  // Unconfigured → no-op success so the client stays localStorage-only.
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: true, address }, { headers: NO_STORE });
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('watchlists')
    .upsert({ owner_id: owner, address }, { onConflict: 'owner_id,address' });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, address }, { headers: NO_STORE });
}

/** DELETE — remove one address for the owner. */
export async function DELETE(request: NextRequest) {
  const limited = writeRateLimited(request);
  if (limited) return limited;

  const { owner, address } = await readBody(request);
  if (!isValidOwner(owner) || !isValidAddress(address)) {
    return NextResponse.json({ error: 'Invalid owner or address' }, { status: 400, headers: NO_STORE });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('watchlists')
    .delete()
    .eq('owner_id', owner)
    .eq('address', address);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
