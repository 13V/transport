/**
 * ALERT DETECTION — high-signal smart-money momentum alerts
 *
 * Instead of one alert per individual smart BUY (noisy, low signal), we alert
 * once per TOKEN when a meaningful number of DISTINCT smart wallets buy it
 * inside a short window. The framing: "smart money is rotating into X".
 *
 * Pipeline (per cron run):
 *   1. getSmartMoneyBuys({ hours: 1 }) — already aggregates distinct smart
 *      buyers, SOL volume and the mint per token.
 *   2. Keep tokens where distinctSmartBuyers >= ALERT_MIN_BUYERS.
 *   3. Drop tokens alerted within ALERT_COOLDOWN_MIN minutes (per-token cooldown
 *      persisted in indexer_state under key 'alert_cooldowns' → { mint: ts }).
 *   4. Enrich with ticker (getTokenMeta) + clickable links and send.
 *   5. Persist updated cooldowns.
 *
 * Funding-link alerts (near-zero trader value) are removed from the default
 * path and only run when ALERT_FUNDING=1.
 *
 * Resilient: never throws out of the cron path. Any failure (Supabase, meta,
 * send) is caught and the run returns a sane summary.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getSmartMoneyBuys } from '@/lib/indexer/smart-buys';
import { getTokenMeta } from '@/lib/token-meta';
import { tokenLinks } from '@/lib/trade-links';
import { sendAlert, escapeHtml } from './notifier';

const COOLDOWN_KEY = 'alert_cooldowns';
const FUNDING_CAP = 25;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function short(s: string): string {
  return (s || '').slice(0, 6);
}

/** Base URL for the token page link. Falls back to localhost for dev. */
function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

function fmtSol(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 100) return Math.round(n).toString();
  return (Math.round(n * 100) / 100).toString();
}

/**
 * Summary returned to the cron route. NOTE: the route wraps this as
 * `{ ok: true, ...result }`, so we deliberately do NOT include an `ok` key here
 * — that would collide with the route's literal and is reported by tsc. The
 * HTTP response still carries `ok`; `ok` is supplied by the route (true on a
 * normal return, false when this function throws — which it never does).
 */
export interface DetectResult {
  momentumAlertsSent: number;
  tokensConsidered: number;
}

export async function detectAndAlert(): Promise<DetectResult> {
  if (!isSupabaseConfigured()) {
    return { momentumAlertsSent: 0, tokensConsidered: 0 };
  }

  const minBuyers = envInt('ALERT_MIN_BUYERS', 3);
  const cooldownMin = envInt('ALERT_COOLDOWN_MIN', 60);
  const cooldownMs = cooldownMin * 60_000;
  const now = Date.now();

  let momentumAlertsSent = 0;
  let tokensConsidered = 0;

  try {
    const supabase = getSupabase();

    // 1. Pull aggregated smart-money buys for the last hour.
    const result = await getSmartMoneyBuys({ hours: 1 });
    const candidates = result.tokens.filter(
      (t) => t.mint && t.distinctSmartBuyers >= minBuyers
    );
    tokensConsidered = candidates.length;

    if (candidates.length === 0) {
      return { momentumAlertsSent: 0, tokensConsidered: 0 };
    }

    // 2. Load per-token cooldowns from indexer_state.
    let cooldowns: Record<string, number> = {};
    try {
      const { data: stateRow } = await supabase
        .from('indexer_state')
        .select('value')
        .eq('key', COOLDOWN_KEY)
        .maybeSingle();
      const value = (stateRow?.value ?? {}) as Record<string, unknown>;
      for (const [mint, ts] of Object.entries(value)) {
        const n = Number(ts);
        if (Number.isFinite(n)) cooldowns[mint] = n;
      }
    } catch (error) {
      console.error('[ALERT] Failed to read cooldowns:', (error as Error).message);
    }

    // 3. Filter out tokens still within their cooldown window.
    const fresh = candidates.filter((t) => {
      const last = cooldowns[t.mint];
      return !(typeof last === 'number' && now - last < cooldownMs);
    });

    if (fresh.length === 0) {
      return { momentumAlertsSent: 0, tokensConsidered };
    }

    // 4. Enrich with ticker metadata (resilient — never throws).
    let metaByMint = new Map<string, { symbol?: string }>();
    try {
      metaByMint = await getTokenMeta(fresh.map((t) => t.mint));
    } catch (error) {
      console.error('[ALERT] token meta lookup failed:', (error as Error).message);
    }

    const base = appBaseUrl();

    for (const t of fresh) {
      const meta = metaByMint.get(t.mint);
      const ticker = meta?.symbol ? `$${meta.symbol}` : short(t.mint) + '…';
      const links = tokenLinks(t.mint);
      const trade = links.filter((l) => l.kind === 'trade').slice(0, 2);

      const linkParts: string[] = [
        `<a href="${escapeHtml(`${base}/token/${t.mint}`)}">Open</a>`,
        ...trade.map(
          (l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`
        ),
      ];

      const wallets = t.distinctSmartBuyers === 1 ? 'wallet' : 'wallets';
      const text =
        `🟢 <b>${escapeHtml(ticker)}</b> — ${t.distinctSmartBuyers} smart ${wallets} bought` +
        ` · ${fmtSol(t.solVolume)} SOL\n` +
        linkParts.join(' · ');

      try {
        await sendAlert(text);
        momentumAlertsSent += 1;
        cooldowns[t.mint] = now; // mark only on successful-ish send
      } catch (error) {
        console.error('[ALERT] send failed for', t.mint, (error as Error).message);
      }
    }

    // 5. Persist updated cooldowns. Prune entries older than 2x the cooldown
    // window to keep the JSON blob from growing unbounded.
    try {
      const pruneBefore = now - cooldownMs * 2;
      const pruned: Record<string, number> = {};
      for (const [mint, ts] of Object.entries(cooldowns)) {
        if (ts >= pruneBefore) pruned[mint] = ts;
      }
      await supabase.from('indexer_state').upsert(
        {
          key: COOLDOWN_KEY,
          value: pruned,
          updated_at: new Date(now).toISOString(),
        },
        { onConflict: 'key' }
      );
    } catch (error) {
      console.error('[ALERT] Failed to persist cooldowns:', (error as Error).message);
    }
  } catch (error) {
    console.error('[ALERT] Momentum detection failed:', (error as Error).message);
    return { momentumAlertsSent, tokensConsidered };
  }

  // Optional: quiet funding-link alerts, gated behind ALERT_FUNDING=1.
  if (process.env.ALERT_FUNDING === '1') {
    try {
      await sendFundingAlerts();
    } catch (error) {
      console.error('[ALERT] Funding detection failed:', (error as Error).message);
    }
  }

  return { momentumAlertsSent, tokensConsidered };
}

/**
 * Legacy funding-link alerts, retained behind ALERT_FUNDING=1. Uses its own
 * cursor in indexer_state so it doesn't re-alert the same links. Best-effort.
 */
async function sendFundingAlerts(): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  const now = new Date();
  const STATE_KEY = 'last_alert_funding';
  let lastFundingAt = new Date(now.getTime() - 3600_000).toISOString();

  try {
    const { data: stateRow } = await supabase
      .from('indexer_state')
      .select('value')
      .eq('key', STATE_KEY)
      .maybeSingle();
    const value = (stateRow?.value ?? {}) as { lastFundingAt?: string };
    if (typeof value.lastFundingAt === 'string') lastFundingAt = value.lastFundingAt;
  } catch {
    /* default window */
  }

  let maxFundingAt = lastFundingAt;
  let sent = 0;
  const { data: linkRows, error } = await supabase
    .from('wallet_links')
    .select('source, target, amount_sol, last_seen')
    .gt('last_seen', lastFundingAt)
    .order('last_seen', { ascending: false })
    .limit(50);
  if (error) throw error;

  for (const l of linkRows ?? []) {
    const lastSeen = l.last_seen as string;
    if (lastSeen > maxFundingAt) maxFundingAt = lastSeen;
    if (sent < FUNDING_CAP) {
      await sendAlert(
        `🔗 ${short(l.source as string)}… funded ${short(l.target as string)}… (${l.amount_sol} SOL)`
      );
      sent += 1;
    }
  }

  const nowIso = now.toISOString();
  await supabase.from('indexer_state').upsert(
    {
      key: STATE_KEY,
      value: { lastFundingAt: maxFundingAt > lastFundingAt ? maxFundingAt : nowIso },
      updated_at: nowIso,
    },
    { onConflict: 'key' }
  );
}
