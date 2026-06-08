/**
 * WEB-PUSH SUBSCRIPTION STORE
 *
 * Stores/removes browser PushManager subscriptions so the Helius webhook's
 * burst-alert step can fan out real-time alerts to web users (no Telegram).
 * Backs the 🔔 Alerts button in the Live feed (components/LiveFeed.tsx).
 *
 *   GET    /api/push/subscribe                       → { vapidPublicKey }
 *   POST   /api/push/subscribe { subscription, owner } → { ok }   (upsert)
 *   DELETE /api/push/subscribe { endpoint }            → { ok }   (remove)
 *
 * The client PREFERS NEXT_PUBLIC_VAPID_PUBLIC_KEY for applicationServerKey; the
 * GET here is a fallback so the key can be discovered without a public env.
 *
 * Degrades gracefully like the watchlist route: when Supabase isn't configured,
 * writes are 200 no-ops so the UI never breaks. Shapes are validated.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { getPublicVapidKey } from '../../../../lib/push';
import { rateLimit, clientIp } from '../../../../lib/rate-limit';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// Per-IP write cap (near-term abuse mitigation; identity is a self-asserted
// owner id, so the IP limiter is the cheap guardrail on the mutating path).
const WRITE_RL_MAX = 60;

/** Returns a 429 response when the per-IP write budget is exhausted, else null. */
function writeRateLimited(request: NextRequest): NextResponse | null {
  const rl = rateLimit('push-subscribe-write', clientIp(request), WRITE_RL_MAX);
  if (rl.ok) return null;
  return NextResponse.json(
    { error: 'Rate limit exceeded' },
    { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfter) } }
  );
}

// Owner is the same stable per-device id as the watchlist (UUID or, later, a
// wallet address). Optional on a subscription — endpoint is the real key.
const OWNER_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Validate a browser PushSubscription JSON shape. */
function parseSubscription(v: unknown): PushSub | null {
  if (!v || typeof v !== 'object') return null;
  const sub = v as Record<string, unknown>;
  const endpoint = sub.endpoint;
  const keys = sub.keys as Record<string, unknown> | undefined;
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) return null;
  if (!keys || typeof keys !== 'object') return null;
  const p256dh = keys.p256dh;
  const auth = keys.auth;
  if (typeof p256dh !== 'string' || !p256dh) return null;
  if (typeof auth !== 'string' || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** GET — expose the public VAPID key (fallback for clients without the env). */
export async function GET() {
  return NextResponse.json(
    { vapidPublicKey: getPublicVapidKey() },
    { headers: NO_STORE }
  );
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** POST — upsert a subscription for this device. */
export async function POST(request: NextRequest) {
  const limited = writeRateLimited(request);
  if (limited) return limited;

  const body = await readBody(request);
  const sub = parseSubscription(body.subscription);
  if (!sub) {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400, headers: NO_STORE });
  }

  const ownerRaw = body.owner;
  const owner = typeof ownerRaw === 'string' && OWNER_RE.test(ownerRaw) ? ownerRaw : null;

  // Unconfigured → no-op success (UI stays functional, just no server fan-out).
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  const supabase = getSupabase();
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      endpoint: sub.endpoint,
      owner_id: owner,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    },
    { onConflict: 'endpoint' }
  );

  if (error) {
    // Table missing / pre-migration → behave as unconfigured rather than 500.
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

/** DELETE — remove a subscription by endpoint. */
export async function DELETE(request: NextRequest) {
  const limited = writeRateLimited(request);
  if (limited) return limited;

  const body = await readBody(request);
  const endpoint = body.endpoint;
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) {
    return NextResponse.json({ error: 'Invalid endpoint' }, { status: 400, headers: NO_STORE });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint);

  if (error) {
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
