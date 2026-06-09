/**
 * GMGN ↔ HELIUS CALIBRATION / AUDIT
 *
 * Answers, with numbers, "does GMGN's cheap screen match our expensive Helius
 * deep-scan?" — the prerequisite for trusting GMGN as a verification source
 * instead of burning Enhanced-Transactions credits.
 *
 * It pulls every wallet scored BOTH ways (verified=true via Helius AND carrying
 * a GMGN screen) and reports agreement between the two independent measurements:
 *   - win rate:    MAE, correlation, % within ±0.10        (directly comparable)
 *   - token count: correlation, median(screen/ours) ratio  (directly comparable)
 *   - profit SIGN: % where realized_pnl and screen_profit_usd agree on sign
 *     (units differ — SOL vs USD — so only the sign/rank is meaningful)
 *
 * If win rate + token count line up tightly and profit signs agree, GMGN's
 * indexing is faithful to chain reality, so its ROI can be trusted too. This
 * same endpoint is the ongoing cheap audit once the GMGN-verified tier ships.
 *
 *   GET /api/admin/gmgn-calibration   (Authorization: Bearer <CRON_SECRET>)
 */

import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { fetchAllRows } from '../../../../lib/db-paginate';

export const dynamic = 'force-dynamic';

interface Row {
  wallet: string;
  win_rate: number | null;
  tokens_traded: number | null;
  realized_pnl: number | null;
  roi_pct: number | null;
  screen_win_rate: number | null;
  screen_token_count: number | null;
  screen_profit_usd: number | null;
  screen_pass: boolean | null;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const d = Math.sqrt(sxx * syy);
  return d === 0 ? NaN : sxy / d;
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });

  const supabase = getSupabase();
  const cols = 'wallet, win_rate, tokens_traded, realized_pnl, roi_pct, screen_win_rate, screen_token_count, screen_profit_usd, screen_pass';

  // Every wallet scored BOTH ways: Helius-verified AND carrying a GMGN screen.
  const { data, error } = await fetchAllRows<Row>(
    () => supabase
      .from('wallet_stats')
      .select(cols)
      .eq('verified', true)
      .not('screen_win_rate', 'is', null) as any,
    { pageSize: 1000, cap: 60_000 }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const both = rows.filter(r => r.win_rate != null && r.screen_win_rate != null);

  // --- win rate agreement ---
  const wrOurs = both.map(r => Number(r.win_rate));
  const wrGmgn = both.map(r => Number(r.screen_win_rate));
  const wrAbsErr = both.map((_, i) => Math.abs(wrOurs[i] - wrGmgn[i]));
  const wrMae = wrAbsErr.length ? wrAbsErr.reduce((a, b) => a + b, 0) / wrAbsErr.length : NaN;
  const wrWithin10 = wrAbsErr.length ? wrAbsErr.filter(e => e <= 0.10).length / wrAbsErr.length : NaN;

  // --- token count agreement (only rows where both present and ours > 0) ---
  const tcRows = both.filter(r => r.tokens_traded != null && r.screen_token_count != null && Number(r.tokens_traded) > 0);
  const tcOurs = tcRows.map(r => Number(r.tokens_traded));
  const tcGmgn = tcRows.map(r => Number(r.screen_token_count));
  const tcRatios = tcRows.map((_, i) => tcGmgn[i] / tcOurs[i]);

  // --- profit SIGN agreement (units differ; sign/rank is what's comparable) ---
  const pf = both.filter(r => r.realized_pnl != null && r.screen_profit_usd != null);
  const signAgree = pf.length
    ? pf.filter(r => Math.sign(Number(r.realized_pnl)) === Math.sign(Number(r.screen_profit_usd))).length / pf.length
    : NaN;

  // --- would GMGN's own screen have re-selected the wallets WE verified as smart? ---
  const screenPassRate = both.length ? both.filter(r => r.screen_pass === true).length / both.length : NaN;

  return NextResponse.json({
    pairs_scored_both_ways: both.length,
    win_rate: {
      mae: round(wrMae),                     // mean |ours − gmgn|, on a 0..1 scale
      correlation: round(pearson(wrOurs, wrGmgn)),
      within_0_10: round(wrWithin10),        // share within ±10 percentage points
    },
    token_count: {
      n: tcRows.length,
      correlation: round(pearson(tcOurs, tcGmgn)),
      median_ratio_gmgn_over_ours: round(median(tcRatios)),
    },
    profit_sign_agreement: round(signAgree),
    gmgn_screen_pass_rate_on_our_verified: round(screenPassRate),
    note: 'win_rate & token_count are directly comparable; profit differs in units (SOL vs USD) so only sign/rank is meaningful. High win-rate correlation + low MAE + high sign-agreement ⇒ GMGN faithfully tracks chain reality and its ROI can be trusted for a GMGN-verified tier.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
