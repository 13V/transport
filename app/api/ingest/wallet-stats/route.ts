/**
 * GMGN SCREEN INGEST
 *
 * The cost-saver: an external gmgn-cli job (GitHub Action) screens captured
 * wallets cheaply via GMGN's API and reports the results here. We store a "screen"
 * tier and flag the promising ones so the expensive Helius deep-scan only
 * verifies wallets GMGN says are actually profitable — not every captured wallet.
 *
 *   GET  /api/ingest/wallet-stats?limit=200   → addresses that still need screening
 *   POST /api/ingest/wallet-stats             → { source, wallets: [...] } screen results
 *
 * Both require Authorization: Bearer <CRON_SECRET> when CRON_SECRET is set.
 * GMGN numbers are a SCREEN only — the displayed source of truth stays the
 * Helius-derived accurate ROI (verified tier).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';

function authed(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

/** GET — wallets that still need a GMGN screen (unverified, unscreened). */
export async function GET(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });

  const limit = Math.min(Math.max(parseInt(request.nextUrl.searchParams.get('limit') || '200', 10) || 200, 1), 1000);
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('wallet_stats')
    .select('wallet')
    .eq('verified', false)
    .is('screened_at', null)
    .order('total_trades', { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(
    { count: data?.length ?? 0, wallets: (data ?? []).map((r: any) => r.wallet) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

interface ScreenInput {
  address: string;
  winRate?: number; // 0..1
  realizedProfitUsd?: number;
  tokenCount?: number;
  tradeCount?: number;
  avgHoldSeconds?: number;
}

/** POST — store GMGN screen results and flag the promising wallets. */
export async function POST(request: NextRequest) {
  if (!authed(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const items: ScreenInput[] = Array.isArray(body?.wallets) ? body.wallets : [];
  if (items.length === 0) return NextResponse.json({ error: 'No wallets provided' }, { status: 400 });

  // Lenient pre-filter — Helius does the real gate, this just decides who's worth
  // the expensive verify. Profitable + a bit of breadth.
  const minProfit = num('SCREEN_MIN_PROFIT_USD', 0);
  // Aligned with curation's minTokens (3): the cheap pre-screen must not be
  // STRICTER than the final gate, or it would discard wallets the gate would pass.
  const minTokens = num('SCREEN_MIN_TOKENS', 3);

  const now = new Date().toISOString();
  const rows = items
    .filter((w) => typeof w?.address === 'string' && w.address.length >= 32 && w.address.length <= 44)
    .map((w) => {
      const profit = Number(w.realizedProfitUsd ?? 0);
      const tokens = Number(w.tokenCount ?? 0);
      return {
        wallet: w.address,
        screened_at: now,
        screen_pass: profit > minProfit && tokens >= minTokens,
        screen_profit_usd: Number.isFinite(profit) ? profit : null,
        screen_win_rate: w.winRate == null ? null : Number(w.winRate),
        screen_token_count: Number.isFinite(tokens) ? tokens : null,
      };
    });

  const supabase = getSupabase();
  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('wallet_stats')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'wallet' });
    if (error) {
      return NextResponse.json(
        { error: error.message, hint: 'Run the screen-column migration on wallet_stats' },
        { status: 500 }
      );
    }
    upserted += rows.slice(i, i + CHUNK).length;
  }

  const passed = rows.filter((r) => r.screen_pass).length;
  return NextResponse.json({ ok: true, received: items.length, upserted, screenPass: passed });
}
