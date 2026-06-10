/**
 * GMGN TOKEN-SECURITY INGEST
 *
 * The rug/bundle data path: an external gmgn-cli job (GitHub Action — the CLI
 * cannot run on Vercel) fetches per-token security (bundler/sniper rates, holder
 * concentration, honeypot/taxes, creator rug history) for the tokens our bursts
 * are firing on, and reports the results here. The live feed then flags
 * dangerous tokens loudly. Zero Helius anywhere in this pipeline.
 *
 *   GET  /api/ingest/token-security?limit=100&hours=12&staleHours=6
 *        → recent burst mints with no token_security row or one staler than
 *          staleHours — i.e. "what the CI worker should fetch next".
 *   POST /api/ingest/token-security  { tokens: [{ mint, bundlerRate, ... }] }
 *
 * Both require Authorization: Bearer <CRON_SECRET> (fails closed). Degrades
 * gracefully pre-migration-0024 (GET still lists mints; POST reports the
 * missing table instead of 500-ing the worker into backoff).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** GET — burst mints that still need a (fresh) security row. */
export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });

  const sp = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(parseInt(sp.get('limit') || '100', 10) || 100, 1), 300);
  const hours = Math.min(Math.max(parseInt(sp.get('hours') || '12', 10) || 12, 1), 72);
  const staleHours = Math.min(Math.max(parseInt(sp.get('staleHours') || '6', 10) || 6, 1), 72);
  const supabase = getSupabase();

  // Distinct mints from recent bursts, newest first (the tokens users are
  // actually looking at). live_bursts is small and indexed on window_end.
  const sinceIso = new Date(Date.now() - hours * 3_600_000).toISOString();
  const { data: burstRows, error: burstErr } = await supabase
    .from('live_bursts')
    .select('mint, window_end')
    .gte('window_end', sinceIso)
    .order('window_end', { ascending: false })
    .limit(1000);
  if (burstErr) return NextResponse.json({ error: burstErr.message }, { status: 500 });

  const mints: string[] = [];
  const seen = new Set<string>();
  for (const r of (burstRows ?? []) as any[]) {
    const m = String(r.mint ?? '');
    if (m && !seen.has(m) && MINT_RE.test(m)) { seen.add(m); mints.push(m); }
  }
  if (mints.length === 0) return NextResponse.json({ count: 0, mints: [] }, { headers: { 'Cache-Control': 'no-store' } });

  // Drop mints that already have a FRESH security row. Tolerate a pre-0024 DB
  // (missing table → treat as "nothing covered yet" so the GET still works;
  // the worker's POST will surface the missing-table hint).
  const freshCut = new Date(Date.now() - staleHours * 3_600_000).toISOString();
  const covered = new Set<string>();
  try {
    const { data: secRows, error: secErr } = await supabase
      .from('token_security')
      .select('mint, fetched_at')
      .in('mint', mints)
      .gte('fetched_at', freshCut);
    if (!secErr) for (const r of (secRows ?? []) as any[]) covered.add(String(r.mint));
  } catch { /* pre-migration — nothing covered */ }

  const todo = mints.filter((m) => !covered.has(m)).slice(0, limit);
  return NextResponse.json({ count: todo.length, mints: todo }, { headers: { 'Cache-Control': 'no-store' } });
}

interface SecurityInput {
  mint: string;
  bundlerRate?: number | null;
  sniperCount?: number | null;
  top10HolderRate?: number | null;
  freshWalletRate?: number | null;
  botDegenRate?: number | null;
  rugRatio?: number | null;
  isHoneypot?: boolean | null;
  buyTax?: number | null;
  sellTax?: number | null;
  creator?: string | null;
  creatorRugCount?: number | null;
  creatorTokenCount?: number | null;
}

const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** POST — upsert the worker's security results. */
export async function POST(request: NextRequest) {
  if (cronAuthFails(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const items: SecurityInput[] = Array.isArray(body?.tokens) ? body.tokens : [];
  if (items.length === 0) return NextResponse.json({ error: 'No tokens provided' }, { status: 400 });

  const now = new Date().toISOString();
  const rows = items
    .filter((t) => typeof t?.mint === 'string' && MINT_RE.test(t.mint))
    .map((t) => ({
      mint: t.mint,
      bundler_rate: numOrNull(t.bundlerRate),
      sniper_count: numOrNull(t.sniperCount),
      top10_holder_rate: numOrNull(t.top10HolderRate),
      fresh_wallet_rate: numOrNull(t.freshWalletRate),
      bot_degen_rate: numOrNull(t.botDegenRate),
      rug_ratio: numOrNull(t.rugRatio),
      is_honeypot: t.isHoneypot == null ? null : Boolean(t.isHoneypot),
      buy_tax: numOrNull(t.buyTax),
      sell_tax: numOrNull(t.sellTax),
      creator: typeof t.creator === 'string' && t.creator ? t.creator : null,
      creator_rug_count: numOrNull(t.creatorRugCount),
      creator_token_count: numOrNull(t.creatorTokenCount),
      fetched_at: now,
    }));
  if (rows.length === 0) return NextResponse.json({ error: 'No valid tokens' }, { status: 400 });

  const supabase = getSupabase();
  const { error } = await supabase.from('token_security').upsert(rows, { onConflict: 'mint' });
  if (error) {
    return NextResponse.json(
      { error: error.message, hint: 'Apply migration 0024_token_security.sql' },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, upserted: rows.length });
}
