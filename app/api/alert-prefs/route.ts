/**
 * ALERT PREFERENCES STORE
 *
 * Per-user alert tuning, keyed by the same opaque `owner` identity used by the
 * watchlist + web-push subscriptions (a stable per-device UUID generated
 * client-side, localStorage key `sm_owner_id`). It can later be swapped for a
 * connected wallet address with no schema change.
 *
 *   GET   /api/alert-prefs?owner=<id>   → { owner, prefs }   (defaults if none)
 *   POST  /api/alert-prefs  { owner, ...fields } → { ok, prefs }  (upsert)
 *
 * Degrades gracefully like /api/watchlist: when Supabase isn't configured (or
 * the table is pre-migration), GET returns defaults and POST is a 200 no-op so
 * the UI never breaks. Honored today by the webhook's per-user watchlist push
 * (the `muted` flag).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../lib/supabase-client';

// Writes — never cache.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// Owner ids are UUIDs today or, later, wallet addresses — keep to a sane
// length/charset to reject junk without over-fitting (mirrors the watchlist route).
const OWNER_RE = /^[A-Za-z0-9_-]{8,64}$/;

interface AlertPrefs {
  minBuyers: number;
  minSol: number;
  requireS: boolean;
  exitAlerts: boolean;
  muted: boolean;
  telegramChatId: string | null;
}

const DEFAULTS: AlertPrefs = {
  minBuyers: 4,
  minSol: 5,
  requireS: true,
  exitAlerts: true,
  muted: false,
  telegramChatId: null,
};

function isValidOwner(v: unknown): v is string {
  return typeof v === 'string' && OWNER_RE.test(v);
}

/** Map a DB row (snake_case) to the API shape, falling back to defaults. */
function rowToPrefs(row: Record<string, unknown> | null | undefined): AlertPrefs {
  if (!row) return { ...DEFAULTS };
  const minBuyers = Number(row.min_buyers);
  const minSol = Number(row.min_sol);
  const tg = row.telegram_chat_id;
  return {
    minBuyers: Number.isFinite(minBuyers) ? minBuyers : DEFAULTS.minBuyers,
    minSol: Number.isFinite(minSol) ? minSol : DEFAULTS.minSol,
    requireS: row.require_s == null ? DEFAULTS.requireS : Boolean(row.require_s),
    exitAlerts: row.exit_alerts == null ? DEFAULTS.exitAlerts : Boolean(row.exit_alerts),
    muted: Boolean(row.muted),
    telegramChatId: typeof tg === 'string' && tg ? tg : null,
  };
}

/** GET — the owner's prefs, or defaults if none/unconfigured. */
export async function GET(request: NextRequest) {
  const owner = request.nextUrl.searchParams.get('owner');
  if (!isValidOwner(owner)) {
    return NextResponse.json({ error: 'Invalid owner' }, { status: 400, headers: NO_STORE });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ owner, prefs: DEFAULTS }, { headers: NO_STORE });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('alert_prefs')
    .select('min_buyers, min_sol, require_s, exit_alerts, muted, telegram_chat_id')
    .eq('owner_id', owner)
    .maybeSingle();

  if (error) {
    // Table missing / pre-migration → behave as unconfigured rather than 500.
    return NextResponse.json({ owner, prefs: DEFAULTS }, { headers: NO_STORE });
  }

  return NextResponse.json({ owner, prefs: rowToPrefs(data) }, { headers: NO_STORE });
}

type Body = {
  owner: unknown;
  minBuyers: unknown;
  minSol: unknown;
  requireS: unknown;
  exitAlerts: unknown;
  muted: unknown;
  telegramChatId: unknown;
};

async function readBody(request: NextRequest): Promise<Partial<Body>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Partial<Body>) : {};
  } catch {
    return {};
  }
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** POST — upsert the owner's prefs. Unknown/invalid fields fall back to defaults. */
export async function POST(request: NextRequest) {
  const body = await readBody(request);
  if (!isValidOwner(body.owner)) {
    return NextResponse.json({ error: 'Invalid owner' }, { status: 400, headers: NO_STORE });
  }
  const owner = body.owner;

  const prefs: AlertPrefs = {
    minBuyers: clampInt(body.minBuyers, DEFAULTS.minBuyers, 1, 100),
    minSol: clampNum(body.minSol, DEFAULTS.minSol, 0, 1_000_000),
    requireS: body.requireS == null ? DEFAULTS.requireS : Boolean(body.requireS),
    exitAlerts: body.exitAlerts == null ? DEFAULTS.exitAlerts : Boolean(body.exitAlerts),
    muted: body.muted == null ? DEFAULTS.muted : Boolean(body.muted),
    telegramChatId:
      typeof body.telegramChatId === 'string' && body.telegramChatId
        ? body.telegramChatId.slice(0, 64)
        : null,
  };

  // Unconfigured → no-op success so the client can degrade gracefully.
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: true, prefs }, { headers: NO_STORE });
  }

  const supabase = getSupabase();
  const { error } = await supabase.from('alert_prefs').upsert(
    {
      owner_id: owner,
      min_buyers: prefs.minBuyers,
      min_sol: prefs.minSol,
      require_s: prefs.requireS,
      exit_alerts: prefs.exitAlerts,
      muted: prefs.muted,
      telegram_chat_id: prefs.telegramChatId,
    },
    { onConflict: 'owner_id' }
  );

  if (error) {
    // Table missing / pre-migration → degrade to 200 like the watchlist route.
    return NextResponse.json({ ok: true, prefs }, { headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, prefs }, { headers: NO_STORE });
}
