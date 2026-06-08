/**
 * GROWTH MILESTONE ALERT CRON
 *
 *   GET /api/cron/growth-alert
 *
 * Polls the index totals (wallets indexed / verified / smart) and fires a
 * notification through the existing alert channels (Telegram / ALERT_WEBHOOK_URL)
 * when any of them crosses a milestone step. State (last snapshot + milestone
 * buckets) is persisted in `indexer_state` so it only pings on a NEW crossing,
 * not every run. Safe to poll on a schedule; degrades to a no-op when Supabase
 * or alert channels aren't configured. Never throws.
 *
 * Milestone steps (env-tunable):
 *   GROWTH_STEP_INDEXED  (default 25000)
 *   GROWTH_STEP_VERIFIED (default 500)
 *   GROWTH_STEP_SMART    (default 100)
 *
 * CRON_SECRET-protected when set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { getSmartCriteria } from '../../../../lib/indexer/curation';
import { sendAlert } from '../../../../lib/alerts/notifier';

export const dynamic = 'force-dynamic';

export const maxDuration = 30;

const STATE_KEY = 'growth_alert';

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

async function count(query: any): Promise<number | null> {
  const { count: c, error } = await query;
  return error ? null : c ?? 0;
}

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, error: 'Supabase not configured' }, { status: 503 });
  }

  try {
    const supabase = getSupabase();
    const c = getSmartCriteria();
    const now = Date.now();

    // --- current totals ---
    const indexed = (await count(
      supabase.from('wallet_stats').select('wallet', { count: 'exact', head: true })
    )) ?? 0;
    const verified = (await count(
      supabase.from('wallet_stats').select('wallet', { count: 'exact', head: true }).eq('verified', true)
    )) ?? 0;

    // Smart: cheap gate prefilter count (mirrors the status/list gate conditions).
    let smartQ: any = supabase
      .from('wallet_stats')
      .select('wallet', { count: 'exact', head: true })
      .not('roi_pct', 'is', null)
      .gte('roi_pct', c.minRoiPct)
      .gte('realized_pnl', c.minPnlSol)
      .gte('total_trades', c.minTrades)
      .gte('tokens_traded', c.minTokens);
    if (c.minInvestedSol > 0) smartQ = smartQ.gte('invested_sol', c.minInvestedSol);
    if (c.maxIdleDays > 0) {
      smartQ = smartQ.gte('last_trade_at', new Date(now - c.maxIdleDays * 86_400_000).toISOString());
    }
    const smart = (await count(smartQ)) ?? 0;

    // --- previous snapshot ---
    const { data: stateRow } = await supabase
      .from('indexer_state')
      .select('value')
      .eq('key', STATE_KEY)
      .maybeSingle();
    const prev = (stateRow?.value ?? {}) as { indexed?: number; verified?: number; smart?: number };

    const steps = {
      indexed: envInt('GROWTH_STEP_INDEXED', 25_000),
      verified: envInt('GROWTH_STEP_VERIFIED', 500),
      smart: envInt('GROWTH_STEP_SMART', 100),
    };
    const bucket = (n: number, step: number) => Math.floor(n / step);

    const crossings: string[] = [];
    const firstRun = prev.indexed == null && prev.verified == null && prev.smart == null;
    if (!firstRun) {
      if (bucket(indexed, steps.indexed) > bucket(prev.indexed ?? 0, steps.indexed)) {
        crossings.push(`Indexed ${indexed.toLocaleString()} (+${(indexed - (prev.indexed ?? 0)).toLocaleString()})`);
      }
      if (bucket(verified, steps.verified) > bucket(prev.verified ?? 0, steps.verified)) {
        crossings.push(`Verified ${verified.toLocaleString()} (+${(verified - (prev.verified ?? 0)).toLocaleString()})`);
      }
      if (bucket(smart, steps.smart) > bucket(prev.smart ?? 0, steps.smart)) {
        crossings.push(`Smart ${smart.toLocaleString()} (+${(smart - (prev.smart ?? 0)).toLocaleString()})`);
      }
    }

    let notified = false;
    // Alert only when a milestone is crossed. On first run we just seed state.
    if (crossings.length > 0) {
      const msg =
        `📈 <b>Smart-money index milestone</b>\n` +
        crossings.map((l) => `• ${l}`).join('\n') +
        `\n\nTotals — indexed ${indexed.toLocaleString()} · verified ${verified.toLocaleString()} · smart ${smart.toLocaleString()}`;
      await sendAlert(msg);
      notified = true;
    }

    // Persist the latest snapshot (advances the milestone baseline).
    await supabase.from('indexer_state').upsert(
      {
        key: STATE_KEY,
        value: { indexed, verified, smart, at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );

    return NextResponse.json(
      { ok: true, totals: { indexed, verified, smart }, steps, crossings, notified, firstRun },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
