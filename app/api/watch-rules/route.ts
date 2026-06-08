/**
 * WATCH RULES STORE — custom per-user alert rules.
 *
 * Each rule is owned by the same opaque `owner` identity used by the watchlist,
 * web-push subscriptions, and alert prefs (a stable per-device UUID generated
 * client-side, localStorage key `sm_owner_id`); it can later be swapped for a
 * connected wallet address with no schema change.
 *
 * A rule says: "push me when a burst matches these conditions" —
 *   wallets[]    — only fire if at least one of these wallets is in the burst
 *                  (empty / omitted = any wallet)
 *   min_buyers   — minimum distinct smart-money buyers in the burst
 *   min_sol      — minimum total SOL size of the burst
 *   holding_only — (forward-looking) only fire for wallets the owner watches
 *   channels[]   — delivery channels ('push' now; 'telegram' shown as link-in-bot)
 *   muted        — per-rule kill switch
 *
 *   GET    /api/watch-rules?owner=<id>        → { owner, rules: Rule[] }
 *   POST   /api/watch-rules  { ...rule }      → { ok, rule }   (insert or update)
 *   DELETE /api/watch-rules  { owner, id }    → { ok }         (owner-scoped)
 *
 * Service-role DB access, owner scoped. Degrades gracefully like /api/watchlist:
 * when Supabase isn't configured (or the table is pre-migration), GET returns an
 * empty set and writes are 200 no-ops so the UI never breaks. Inputs validated.
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
  const rl = rateLimit('watch-rules-write', clientIp(request), WRITE_RL_MAX);
  if (rl.ok) return null;
  return NextResponse.json(
    { error: 'Rate limit exceeded' },
    { status: 429, headers: { ...NO_STORE, 'Retry-After': String(rl.retryAfter) } }
  );
}

// Mirrors the watchlist / alert-prefs routes: owner ids are UUIDs today or,
// later, wallet addresses — keep to a sane length/charset to reject junk.
const OWNER_RE = /^[A-Za-z0-9_-]{8,64}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// base58-ish Solana address (no 0, O, I, l).
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Bounds — keep arrays/numbers sane to reject abuse without over-fitting.
const MAX_WALLETS = 50;
const MAX_LABEL = 80;
// Per-owner rule cap. `owner` is a self-asserted, unauthenticated localStorage
// UUID, so without a ceiling anyone could insert unbounded rules — every rule is
// scanned on the Helius webhook's hot ingest path. Cap inserts (updates exempt).
const MAX_RULES_PER_OWNER = 25;
const VALID_CHANNELS = ['push', 'telegram'] as const;
type Channel = (typeof VALID_CHANNELS)[number];

export interface WatchRule {
  id: string | null;
  owner: string;
  label: string | null;
  wallets: string[];
  minBuyers: number;
  minSol: number;
  holdingOnly: boolean;
  channels: Channel[];
  muted: boolean;
  createdAt?: string;
}

function isValidOwner(v: unknown): v is string {
  return typeof v === 'string' && OWNER_RE.test(v);
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

/** Sanitize a wallets array: dedupe, validate base58 shape, cap length. */
function cleanWallets(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of v) {
    if (typeof w !== 'string' || !ADDRESS_RE.test(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_WALLETS) break;
  }
  return out;
}

/** Sanitize channels: keep only known channels, dedupe, default to ['push']. */
function cleanChannels(v: unknown): Channel[] {
  if (!Array.isArray(v)) return ['push'];
  const out: Channel[] = [];
  for (const c of v) {
    if (typeof c === 'string' && (VALID_CHANNELS as readonly string[]).includes(c) && !out.includes(c as Channel)) {
      out.push(c as Channel);
    }
  }
  return out.length > 0 ? out : ['push'];
}

/** Map a DB row (snake_case) to the API shape. */
function rowToRule(row: Record<string, unknown>): WatchRule {
  return {
    id: typeof row.id === 'string' ? row.id : null,
    owner: typeof row.owner === 'string' ? row.owner : '',
    label: typeof row.label === 'string' && row.label ? row.label : null,
    wallets: cleanWallets(row.wallets),
    minBuyers: clampInt(row.min_buyers, 3, 0, 1000),
    minSol: clampNum(row.min_sol, 0, 0, 1_000_000),
    holdingOnly: Boolean(row.holding_only),
    channels: cleanChannels(row.channels),
    muted: Boolean(row.muted),
    createdAt: typeof row.created_at === 'string' ? row.created_at : undefined,
  };
}

/** GET — all rules for the owner, newest first. */
export async function GET(request: NextRequest) {
  const owner = request.nextUrl.searchParams.get('owner');
  if (!isValidOwner(owner)) {
    return NextResponse.json({ error: 'Invalid owner' }, { status: 400, headers: NO_STORE });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ owner, rules: [] }, { headers: NO_STORE });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('watch_rules')
    .select('id, owner, label, wallets, min_buyers, min_sol, holding_only, channels, muted, created_at')
    .eq('owner', owner)
    .order('created_at', { ascending: false });

  if (error) {
    // Table missing / pre-migration → behave as unconfigured rather than 500.
    return NextResponse.json({ owner, rules: [] }, { headers: NO_STORE });
  }

  const rules = (data ?? []).map((r) => rowToRule(r as Record<string, unknown>));
  return NextResponse.json({ owner, rules }, { headers: NO_STORE });
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** POST — insert a new rule or update an existing one (owner-scoped upsert). */
export async function POST(request: NextRequest) {
  const limited = writeRateLimited(request);
  if (limited) return limited;

  const body = await readBody(request);
  if (!isValidOwner(body.owner)) {
    return NextResponse.json({ error: 'Invalid owner' }, { status: 400, headers: NO_STORE });
  }
  const owner = body.owner as string;

  // Optional id for update; reject malformed ids rather than silently inserting.
  const id =
    typeof body.id === 'string' && body.id ? (UUID_RE.test(body.id) ? body.id : null) : undefined;
  if (id === null) {
    return NextResponse.json({ error: 'Invalid rule id' }, { status: 400, headers: NO_STORE });
  }

  const labelRaw = body.label;
  const label =
    typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim().slice(0, MAX_LABEL) : null;

  const rule = {
    owner,
    label,
    wallets: cleanWallets(body.wallets),
    min_buyers: clampInt(body.minBuyers, 3, 0, 1000),
    min_sol: clampNum(body.minSol, 0, 0, 1_000_000),
    holding_only: Boolean(body.holdingOnly),
    channels: cleanChannels(body.channels),
    muted: Boolean(body.muted),
  };

  if (!isSupabaseConfigured()) {
    // No-op success so the client can degrade gracefully.
    return NextResponse.json(
      { ok: true, rule: rowToRule({ id: id ?? null, ...rule }) },
      { headers: NO_STORE }
    );
  }

  const supabase = getSupabase();

  if (id) {
    // UPDATE — scoped to owner so a forged id can't edit someone else's rule.
    const { data, error } = await supabase
      .from('watch_rules')
      .update(rule)
      .eq('id', id)
      .eq('owner', owner)
      .select('id, owner, label, wallets, min_buyers, min_sol, holding_only, channels, muted, created_at')
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
    }
    if (!data) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, rule: rowToRule(data as Record<string, unknown>) }, { headers: NO_STORE });
  }

  // PER-OWNER CAP — inserts only (updates above are exempt). Count the owner's
  // existing rules and reject at the cap so an unauthenticated owner can't insert
  // unbounded rules that bloat the webhook's hot-path rule scan. A count error
  // (e.g. table pre-migration) is non-fatal: fall through to the insert, which
  // will itself degrade if the table is missing.
  const { count, error: countErr } = await supabase
    .from('watch_rules')
    .select('id', { count: 'exact', head: true })
    .eq('owner', owner);
  if (!countErr && typeof count === 'number' && count >= MAX_RULES_PER_OWNER) {
    return NextResponse.json(
      { error: `Rule limit reached (max ${MAX_RULES_PER_OWNER} per owner)` },
      { status: 409, headers: NO_STORE }
    );
  }

  // INSERT — new rule.
  const { data, error } = await supabase
    .from('watch_rules')
    .insert(rule)
    .select('id, owner, label, wallets, min_buyers, min_sol, holding_only, channels, muted, created_at')
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, rule: rowToRule((data ?? {}) as Record<string, unknown>) }, { headers: NO_STORE });
}

/** DELETE — remove one rule by id, scoped to owner. */
export async function DELETE(request: NextRequest) {
  const limited = writeRateLimited(request);
  if (limited) return limited;

  const body = await readBody(request);
  if (!isValidOwner(body.owner)) {
    return NextResponse.json({ error: 'Invalid owner' }, { status: 400, headers: NO_STORE });
  }
  const owner = body.owner as string;
  const id = body.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid rule id' }, { status: 400, headers: NO_STORE });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('watch_rules')
    .delete()
    .eq('id', id)
    .eq('owner', owner);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
