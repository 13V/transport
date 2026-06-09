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

// Fractional (average) ranks — ties share the mean rank. Used for Spearman.
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank for the tie group
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
// Spearman = Pearson on ranks — unit-free, so it survives the SOL-vs-USD and
// different-token-universe definitional gaps and answers "same ORDERING?".
const spearman = (xs: number[], ys: number[]) => pearson(ranks(xs), ranks(ys));

// Selection overlap @ top fraction f: of the both-scored set, how much do the
// "top by our metric" and "top by GMGN metric" sets coincide (Jaccard). This is
// the decision-relevant number: would a GMGN gate pick ~the same wallets?
function overlapAtTop(ours: number[], gmgn: number[], f: number): number {
  const n = ours.length;
  const k = Math.max(1, Math.round(n * f));
  const topIdx = (arr: number[]) =>
    new Set(arr.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, k).map(p => p[1]));
  const a = topIdx(ours), b = topIdx(gmgn);
  let inter = 0;
  for (const i of a) if (b.has(i)) inter++;
  return inter / (a.size + b.size - inter); // Jaccard
}

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

  // ?dump=1 — return the both-scored wallets with OUR roi_pct, so an offline
  // gmgn-cli pass can fetch each wallet's GMGN ROI (realized_profit_pnl) and run
  // the final ROI-to-ROI head-to-head with zero Helius cost.
  if (request.nextUrl.searchParams.get('dump') === '1') {
    const lim = Math.min(Math.max(parseInt(request.nextUrl.searchParams.get('limit') || '400', 10) || 400, 1), 2000);
    return NextResponse.json({
      count: both.length,
      wallets: both
        .filter(r => r.roi_pct != null)
        .slice(0, lim)
        .map(r => ({
          wallet: r.wallet,
          roi_pct: Number(r.roi_pct),
          win_rate: r.win_rate == null ? null : Number(r.win_rate),
          screen_win_rate: r.screen_win_rate == null ? null : Number(r.screen_win_rate),
          screen_profit_usd: r.screen_profit_usd == null ? null : Number(r.screen_profit_usd),
        })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

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

  // --- RANK / SELECTION agreement (the decision-relevant view). Rank correlations
  //     are unit-free, so they bypass the SOL-vs-USD + different-token-universe
  //     definitional gaps and ask only "do the two AGREE ON ORDERING?". Selection
  //     overlap asks the bottom line: would a GMGN gate pick the same wallets? ---
  const profOurs = pf.map(r => Number(r.realized_pnl));
  const profGmgn = pf.map(r => Number(r.screen_profit_usd));
  const rank = {
    win_rate_spearman: round(spearman(wrOurs, wrGmgn)),
    profit_spearman: round(spearman(profOurs, profGmgn)),
    // overlap of the top quartile / top half by profit (ours vs GMGN), Jaccard
    profit_overlap_top25pct: round(overlapAtTop(profOurs, profGmgn, 0.25)),
    profit_overlap_top50pct: round(overlapAtTop(profOurs, profGmgn, 0.50)),
  };

  // --- segment by activity: does agreement tighten for more-active (cleaner-
  //     signal) wallets? Buckets on OUR total_trades. ---
  function seg(label: string, pred: (r: Row) => boolean) {
    const g = both.filter(pred);
    const o = g.map(r => Number(r.win_rate)), m = g.map(r => Number(r.screen_win_rate));
    const ae = g.map((_, i) => Math.abs(o[i] - m[i]));
    const pfg = g.filter(r => r.realized_pnl != null && r.screen_profit_usd != null);
    return {
      bucket: label, n: g.length,
      win_rate_mae: g.length ? round(ae.reduce((a, b) => a + b, 0) / ae.length) : null,
      win_rate_spearman: g.length > 2 ? round(spearman(o, m)) : null,
      profit_sign_agreement: pfg.length
        ? round(pfg.filter(r => Math.sign(Number(r.realized_pnl)) === Math.sign(Number(r.screen_profit_usd))).length / pfg.length)
        : null,
    };
  }
  const tt = (r: Row) => Number(r.tokens_traded ?? 0);
  const byActivity = [
    seg('tokens<20', r => tt(r) < 20),
    seg('tokens20-50', r => tt(r) >= 20 && tt(r) < 50),
    seg('tokens50+', r => tt(r) >= 50),
  ];

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
    rank_and_selection: rank,
    by_activity: byActivity,
    note: 'Absolute numbers differ by DEFINITION (GMGN counts ~2.6x more tokens incl. dust; profit is USD vs our SOL), so the decision-relevant metrics are the RANK correlations and selection overlap: if profit_spearman and profit_overlap_top25pct are high, a GMGN gate would pick ~the same wallets as Helius even though the raw numbers disagree.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
