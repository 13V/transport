/**
 * LINK-TRACKING PIPELINE HEALTH
 *
 * One call to verify the whole "track wallet-hoppers" pipeline is actually working:
 * migrations applied, GMGN balance populating, rotation advancing, drained winners
 * detected, and funding edges getting recorded.
 *
 *   GET /api/admin/link-tracking-health   (Authorization: Bearer <CRON_SECRET>)
 */
import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';

const DRAINED_SOL = Number(process.env.LINK_DRAINED_SOL ?? 1.0);

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isSupabaseConfigured()) return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  const supabase = getSupabase();

  // Migration probes: does each optional column exist?
  const hasLinkTs = !(await supabase.from('wallet_stats').select('links_checked_at').limit(1)).error;
  const hasBalance = !(await supabase.from('wallet_stats').select('sol_balance').limit(1)).error;

  // Count helper (head+exact, with an optional refiner). Returns null on error.
  const count = async (refine: (q: any) => any): Promise<number | null> => {
    try {
      const { count, error } = await refine(supabase.from('wallet_stats').select('wallet', { count: 'exact', head: true }));
      return error ? null : count ?? 0;
    } catch { return null; }
  };

  const verifiedWinners = await count((q: any) => q.eq('verified', true).gt('roi_pct', 0));
  const balanceCovered = hasBalance ? await count((q: any) => q.eq('verified', true).gt('roi_pct', 0).not('sol_balance', 'is', null)) : 0;
  const drained = hasBalance ? await count((q: any) => q.eq('verified', true).gt('roi_pct', 0).lt('sol_balance', DRAINED_SOL)) : 0;
  const linkChecked = hasLinkTs ? await count((q: any) => q.eq('verified', true).gt('roi_pct', 0).not('links_checked_at', 'is', null)) : 0;

  // Total funding edges recorded.
  let edgesTotal: number | null = null;
  try {
    const { count: c, error } = await supabase.from('wallet_links').select('source', { count: 'exact', head: true });
    edgesTotal = error ? null : c ?? 0;
  } catch { edgesTotal = null; }

  // Last link-tracking run summary (written by run-link-tracking).
  let lastRun: any = null;
  try {
    const { data } = await supabase.from('indexer_state').select('value, updated_at').eq('key', 'last_link_tracking').maybeSingle();
    lastRun = data?.value ?? null;
    if (lastRun && data?.updated_at) lastRun.updated_at = data.updated_at;
  } catch { /* ignore */ }

  const pct = (a: number | null, b: number | null) =>
    a != null && b != null && b > 0 ? Math.round((100 * a) / b) : null;

  return NextResponse.json({
    migrations: {
      links_checked_at_0022: hasLinkTs ? 'applied' : 'NOT APPLIED',
      sol_balance_0023: hasBalance ? 'applied' : 'NOT APPLIED',
    },
    verified_winners: verifiedWinners,
    balance_coverage: { covered: balanceCovered, of: verifiedWinners, pct: pct(balanceCovered, verifiedWinners) },
    drained_winners: drained,        // these jump the link-scan queue
    link_coverage: { checked: linkChecked, of: verifiedWinners, pct: pct(linkChecked, verifiedWinners) },
    funding_edges_recorded: edgesTotal,
    last_link_tracking_run: lastRun, // { at, winnersScanned, linksRecorded, walletsEnqueued }
    reading: 'Healthy = both migrations applied, balance_coverage climbing after GMGN screens, link_coverage climbing each run (rotation working), drained_winners > 0, and funding_edges_recorded increasing over time.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
