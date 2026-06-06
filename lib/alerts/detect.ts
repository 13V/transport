/**
 * ALERT DETECTION — high-signal smart-money momentum alerts
 *
 * Instead of one alert per individual smart BUY (noisy, low signal), we alert
 * once per TOKEN when a meaningful number of DISTINCT smart wallets buy it
 * inside a short window. The framing: "smart money is rotating into X".
 *
 * We also alert on DISTRIBUTION — when smart money is clearly OFFLOADING a token
 * it was recently accumulating (sellers outnumber buyers, or net SOL flow is
 * strongly negative). Buy and sell alerts use DISTINCT cooldown keys so they
 * never clobber each other.
 *
 * Pipeline (per cron run):
 *   1. getSmartMoneyBuys({ hours: 1 }) — aggregates distinct smart buyers/sellers,
 *      SOL volume, net SOL flow and the mint per token.
 *   2. BUY gates: distinctSmartBuyers >= ALERT_MIN_BUYERS AND
 *      netSolFlow >= ALERT_MIN_NET_SOL (and optional age guards).
 *   3. SELL gates: token had real prior accumulation AND smart money is now
 *      offloading (sellers >= buyers, or netSolFlow <= -ALERT_SELL_NET_SOL).
 *   4. Drop tokens alerted within ALERT_COOLDOWN_MIN minutes (per-token, per-type
 *      cooldown persisted in indexer_state).
 *   5. Enrich with ticker (getTokenMeta) + clickable links and send.
 *   6. Persist updated cooldowns — ONLY for alerts that actually delivered.
 *
 * Env vars (all optional, sane defaults):
 *   - ALERT_MIN_BUYERS     min distinct smart ENTITIES buying           (default 3)
 *   - ALERT_MIN_NET_SOL    min net SOL flow for a BUY alert             (default 5)
 *   - ALERT_COOLDOWN_MIN   per-token-per-type cooldown, minutes         (default 60)
 *   - ALERT_MIN_AGE_MIN    min minutes since first smart buy (0 = off)  (default 0)
 *   - ALERT_MAX_AGE_MIN    max minutes since first smart buy (0 = off)  (default 0)
 *   - ALERT_SELL_ENABLED   set to '0' to disable sell/exit alerts       (default on)
 *   - ALERT_SELL_MIN_BUYERS  min prior buyer entities to qualify a token
 *                            for a distribution alert                    (default 2)
 *   - ALERT_SELL_MIN_SELLERS min distinct seller entities for a sell alert (default 2)
 *   - ALERT_SELL_NET_SOL   net SOL flow must be <= -this for the
 *                          "strongly negative flow" sell trigger         (default 5)
 *   - ALERT_FUNDING        set to '1' to re-enable legacy funding alerts (default off)
 *
 * NOTE: S-tier / per-buyer tier weighting is NOT implemented here because the
 * getSmartMoneyBuys aggregate does not expose per-buyer tier data on this path
 * (only entity-deduped counts, SOL flow and momentum). Adding it would require
 * threading tier through smart-buys.ts, which is out of scope for this change.
 *
 * Resilient: never throws out of the cron path. Any failure (Supabase, meta,
 * send) is caught and the run returns a sane summary.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getSmartMoneyBuys, SmartBuyToken } from '@/lib/indexer/smart-buys';
import { getTokenMeta } from '@/lib/token-meta';
import { tokenLinks } from '@/lib/trade-links';
import { sendAlert, escapeHtml } from './notifier';

// Separate cooldown blobs so a BUY alert never suppresses a later SELL alert on
// the same mint (and vice-versa).
const BUY_COOLDOWN_KEY = 'alert_cooldowns'; // unchanged for backward compat
const SELL_COOLDOWN_KEY = 'alert_cooldowns_sell';
const FUNDING_CAP = 25;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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

function fmtPct(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const r = Math.round(n * 10) / 10;
  return `${r >= 0 ? '+' : ''}${r}%`;
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
  exitAlertsSent: number;
  tokensConsidered: number;
}

/** Read a { mint: ts } cooldown blob from indexer_state. Best-effort. */
async function readCooldowns(
  supabase: ReturnType<typeof getSupabase>,
  key: string
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const { data: stateRow } = await supabase
      .from('indexer_state')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    const value = (stateRow?.value ?? {}) as Record<string, unknown>;
    for (const [mint, ts] of Object.entries(value)) {
      const n = Number(ts);
      if (Number.isFinite(n)) out[mint] = n;
    }
  } catch (error) {
    console.error(`[ALERT] Failed to read cooldowns (${key}):`, (error as Error).message);
  }
  return out;
}

/** Persist a { mint: ts } cooldown blob, pruning stale entries. Best-effort. */
async function writeCooldowns(
  supabase: ReturnType<typeof getSupabase>,
  key: string,
  cooldowns: Record<string, number>,
  now: number,
  cooldownMs: number
): Promise<void> {
  try {
    const pruneBefore = now - cooldownMs * 2;
    const pruned: Record<string, number> = {};
    for (const [mint, ts] of Object.entries(cooldowns)) {
      if (ts >= pruneBefore) pruned[mint] = ts;
    }
    await supabase.from('indexer_state').upsert(
      { key, value: pruned, updated_at: new Date(now).toISOString() },
      { onConflict: 'key' }
    );
  } catch (error) {
    console.error(`[ALERT] Failed to persist cooldowns (${key}):`, (error as Error).message);
  }
}

/** Resolve display tickers for a set of mints. Never throws. */
async function tickersFor(mints: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let metaByMint = new Map<string, { symbol?: string }>();
  try {
    metaByMint = await getTokenMeta(mints);
  } catch (error) {
    console.error('[ALERT] token meta lookup failed:', (error as Error).message);
  }
  for (const mint of mints) {
    const meta = metaByMint.get(mint);
    out.set(mint, meta?.symbol ? `$${meta.symbol}` : short(mint) + '…');
  }
  return out;
}

function linkParts(base: string, mint: string): string[] {
  const links = tokenLinks(mint);
  const trade = links.filter((l) => l.kind === 'trade').slice(0, 2);
  return [
    `<a href="${escapeHtml(`${base}/token/${mint}`)}">Open</a>`,
    ...trade.map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`),
  ];
}

/** Minutes since the first smart buy on a token, or null if unknown. */
function ageMin(t: SmartBuyToken, now: number): number | null {
  if (!t.firstBuy) return null;
  const ts = new Date(t.firstBuy).getTime();
  if (!Number.isFinite(ts)) return null;
  return (now - ts) / 60_000;
}

export async function detectAndAlert(): Promise<DetectResult> {
  if (!isSupabaseConfigured()) {
    return { momentumAlertsSent: 0, exitAlertsSent: 0, tokensConsidered: 0 };
  }

  // BUY gates
  const minBuyers = envInt('ALERT_MIN_BUYERS', 3);
  const minNetSol = envNum('ALERT_MIN_NET_SOL', 5);
  const minAgeMin = envInt('ALERT_MIN_AGE_MIN', 0); // 0 = disabled
  const maxAgeMin = envInt('ALERT_MAX_AGE_MIN', 0); // 0 = disabled

  // SELL / exit gates
  const sellEnabled = process.env.ALERT_SELL_ENABLED !== '0';
  const sellMinPriorBuyers = envInt('ALERT_SELL_MIN_BUYERS', 2);
  const sellMinSellers = envInt('ALERT_SELL_MIN_SELLERS', 2);
  const sellNetSol = envNum('ALERT_SELL_NET_SOL', 5);

  const cooldownMin = envInt('ALERT_COOLDOWN_MIN', 60);
  const cooldownMs = cooldownMin * 60_000;
  const now = Date.now();

  let momentumAlertsSent = 0;
  let exitAlertsSent = 0;
  let tokensConsidered = 0;

  try {
    const supabase = getSupabase();
    const base = appBaseUrl();

    // 1. Pull aggregated smart-money flow for the last hour.
    const result = await getSmartMoneyBuys({ hours: 1 });
    tokensConsidered = result.tokens.length;
    if (result.tokens.length === 0) {
      return { momentumAlertsSent: 0, exitAlertsSent: 0, tokensConsidered: 0 };
    }

    // ---- BUY / accumulation alerts -----------------------------------------
    const buyCandidates = result.tokens.filter((t) => {
      if (!t.mint) return false;
      if (t.distinctSmartBuyers < minBuyers) return false;
      if (t.netSolFlow < minNetSol) return false;
      // Optional age guards — only applied when we actually know the age.
      const age = ageMin(t, now);
      if (minAgeMin > 0 && age != null && age < minAgeMin) return false;
      if (maxAgeMin > 0 && age != null && age > maxAgeMin) return false;
      return true;
    });

    if (buyCandidates.length > 0) {
      const cooldowns = await readCooldowns(supabase, BUY_COOLDOWN_KEY);
      const fresh = buyCandidates.filter((t) => {
        const last = cooldowns[t.mint];
        return !(typeof last === 'number' && now - last < cooldownMs);
      });

      if (fresh.length > 0) {
        const tickers = await tickersFor(fresh.map((t) => t.mint));
        let stamped = false;

        for (const t of fresh) {
          const ticker = tickers.get(t.mint) ?? short(t.mint) + '…';
          const wallets = t.distinctSmartBuyers === 1 ? 'wallet' : 'wallets';
          const pct = fmtPct(t.priceChangeSincePct);
          const text =
            `🟢 <b>${escapeHtml(ticker)}</b> — ${t.distinctSmartBuyers} smart ${wallets} bought` +
            ` · +${fmtSol(t.netSolFlow)} SOL net` +
            (pct ? ` · ${escapeHtml(pct)} since` : '') +
            `\n` +
            linkParts(base, t.mint).join(' · ');

          try {
            const delivered = await sendAlert(text);
            if (delivered) {
              momentumAlertsSent += 1;
              cooldowns[t.mint] = now; // stamp ONLY on confirmed delivery
              stamped = true;
            }
            // On !delivered we intentionally leave the cooldown unset so the
            // next cron tick retries instead of dropping the alert.
          } catch (error) {
            console.error('[ALERT] buy send failed for', t.mint, (error as Error).message);
          }
        }

        if (stamped) {
          await writeCooldowns(supabase, BUY_COOLDOWN_KEY, cooldowns, now, cooldownMs);
        }
      }
    }

    // ---- SELL / distribution (exit) alerts ---------------------------------
    if (sellEnabled) {
      const sellCandidates = result.tokens.filter((t) => {
        if (!t.mint) return false;
        // Only flag distribution on tokens smart money actually accumulated —
        // either now or earlier in the window (buyers present at all).
        if (t.distinctSmartBuyers < sellMinPriorBuyers) return false;
        if (t.sellers < sellMinSellers) return false;
        // Offloading = sellers outnumber buyers, OR net flow strongly negative.
        const offloading =
          t.sellers >= t.distinctSmartBuyers || t.netSolFlow <= -sellNetSol;
        return offloading;
      });

      if (sellCandidates.length > 0) {
        const cooldowns = await readCooldowns(supabase, SELL_COOLDOWN_KEY);
        const fresh = sellCandidates.filter((t) => {
          const last = cooldowns[t.mint];
          return !(typeof last === 'number' && now - last < cooldownMs);
        });

        if (fresh.length > 0) {
          const tickers = await tickersFor(fresh.map((t) => t.mint));
          let stamped = false;

          for (const t of fresh) {
            const ticker = tickers.get(t.mint) ?? short(t.mint) + '…';
            const sellers = t.sellers === 1 ? 'wallet' : 'wallets';
            const pct = fmtPct(t.priceChangeSincePct);
            const text =
              `🔴 <b>${escapeHtml(ticker)}</b> — smart money exiting · ` +
              `${t.sellers} ${sellers} sold · ${fmtSol(t.solSold)} SOL out · ` +
              `${fmtSol(t.netSolFlow)} SOL net` +
              (pct ? ` · ${escapeHtml(pct)} since` : '') +
              `\n` +
              linkParts(base, t.mint).join(' · ');

            try {
              const delivered = await sendAlert(text);
              if (delivered) {
                exitAlertsSent += 1;
                cooldowns[t.mint] = now;
                stamped = true;
              }
            } catch (error) {
              console.error('[ALERT] sell send failed for', t.mint, (error as Error).message);
            }
          }

          if (stamped) {
            await writeCooldowns(supabase, SELL_COOLDOWN_KEY, cooldowns, now, cooldownMs);
          }
        }
      }
    }
  } catch (error) {
    console.error('[ALERT] Momentum detection failed:', (error as Error).message);
    return { momentumAlertsSent, exitAlertsSent, tokensConsidered };
  }

  // Optional: quiet funding-link alerts, gated behind ALERT_FUNDING=1.
  if (process.env.ALERT_FUNDING === '1') {
    try {
      await sendFundingAlerts();
    } catch (error) {
      console.error('[ALERT] Funding detection failed:', (error as Error).message);
    }
  }

  return { momentumAlertsSent, exitAlertsSent, tokensConsidered };
}

/**
 * DAILY DIGEST — "top movers of the day" from real smart-money aggregates.
 *
 * Exported for callers/crons to use. It pulls a 24h getSmartMoneyBuys snapshot
 * and broadcasts the top N tokens by distinct smart buyers (ties broken by net
 * SOL flow). Uses ONLY real aggregates — no fabricated numbers. Degrades to a
 * no-op (returns 0) when Supabase or Telegram isn't configured, since sendAlert
 * itself is a no-op without Telegram env.
 *
 * NOT wired to a cron here: app/api/cron/alerts/route.ts is the per-minute
 * momentum tick, which is the wrong cadence for a once-a-day digest. To enable,
 * add a separate daily cron entry (e.g. app/api/cron/digest/route.ts on a
 * 0 0 * * * schedule) that calls sendDailyDigest().
 *
 * @returns the number of tokens included in the digest (0 if nothing to send).
 */
export async function sendDailyDigest(opts?: { top?: number; hours?: number }): Promise<number> {
  if (!isSupabaseConfigured()) return 0;
  const top = Math.max(1, Math.min(25, opts?.top ?? 10));
  const hours = opts?.hours ?? 24;

  try {
    const result = await getSmartMoneyBuys({ hours, limit: top });
    const movers = result.tokens
      .filter((t) => t.mint && t.distinctSmartBuyers > 0)
      .sort(
        (a, b) =>
          b.distinctSmartBuyers - a.distinctSmartBuyers || b.netSolFlow - a.netSolFlow
      )
      .slice(0, top);

    if (movers.length === 0) return 0;

    const base = appBaseUrl();
    const tickers = await tickersFor(movers.map((t) => t.mint));

    const lines = movers.map((t, i) => {
      const ticker = tickers.get(t.mint) ?? short(t.mint) + '…';
      const pct = fmtPct(t.priceChangeSincePct);
      return (
        `${i + 1}. <b>${escapeHtml(ticker)}</b> — ${t.distinctSmartBuyers} buyers · ` +
        `${fmtSol(t.netSolFlow)} SOL net` +
        (pct ? ` · ${escapeHtml(pct)}` : '') +
        ` · <a href="${escapeHtml(`${base}/token/${t.mint}`)}">Open</a>`
      );
    });

    const header = `📊 <b>Smart-money top movers · last ${hours}h</b>`;
    await sendAlert([header, ...lines].join('\n'));
    return movers.length;
  } catch (error) {
    console.error('[ALERT] Daily digest failed:', (error as Error).message);
    return 0;
  }
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
