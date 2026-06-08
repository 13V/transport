/**
 * DAILY DIGEST CRON ENDPOINT
 *
 * Builds a once-a-day recap of measured smart-money burst outcomes — today's
 * burst count, the median realized return, and the single best call — and sends
 * it via sendAlert (Telegram private + optional public broadcast already handled
 * in the notifier). Every number is from real measured price history; legs with
 * no measurement are simply omitted from the recap, never fabricated.
 *
 *   GET /api/cron/daily-digest
 *
 * CRON_SECRET-protected when set. Schedule once daily (00:05 UTC).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import { getBurstStats } from '../../../../lib/indexer/burst-outcomes';
import { sendAlert, escapeHtml } from '../../../../lib/alerts/notifier';

export const dynamic = 'force-dynamic';

export const maxDuration = 60;

function fmtPct(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

export async function GET(request: NextRequest) {
  if (cronAuthFails(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const stats = await getBurstStats(24);

    const lines: string[] = [];
    lines.push('<b>Smart-money daily recap</b>');
    lines.push(`Bursts (24h): <b>${stats.burstsToday}</b>`);

    // Prefer 1h median (more legs measured); fall back to 24h.
    if (stats.medianRet1h != null) {
      const hit = stats.hitRate1h != null ? ` (${stats.hitRate1h.toFixed(0)}% in profit)` : '';
      lines.push(`Median 1h: <b>${fmtPct(stats.medianRet1h)}</b>${hit}`);
    } else if (stats.medianRet24h != null) {
      const hit = stats.hitRate24h != null ? ` (${stats.hitRate24h.toFixed(0)}% in profit)` : '';
      lines.push(`Median 24h: <b>${fmtPct(stats.medianRet24h)}</b>${hit}`);
    } else {
      lines.push('No measured outcomes yet.');
    }

    if (stats.bestCall) {
      const label = stats.bestCall.symbol
        ? escapeHtml(stats.bestCall.symbol)
        : `${stats.bestCall.mint.slice(0, 4)}…${stats.bestCall.mint.slice(-4)}`;
      lines.push(`Best call: <b>${label}</b> ${fmtPct(stats.bestCall.ret)}`);
    }

    const text = lines.join('\n');

    // Only broadcast when there's something measured to say; otherwise no-op so
    // an empty day doesn't spam channels.
    let sent = false;
    if (stats.burstsToday > 0 || stats.bestCall || stats.medianRet1h != null) {
      sent = await sendAlert(text);
    }

    return NextResponse.json(
      { ok: true, sent, stats },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[CRON] daily-digest crashed:', error);
    // Resilient 200: a digest hiccup must not fail the scheduler.
    return NextResponse.json(
      { ok: false, sent: false, error: (error as Error).message },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
