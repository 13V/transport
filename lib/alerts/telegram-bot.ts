/**
 * TELEGRAM BOT — per-user subscriptions + matched burst broadcast.
 *
 * This is the inbound/fan-out half of the Telegram channel (the outbound public
 * broadcast lives in notifier.ts + calls.ts). It owns:
 *   - sendToChat()      — send one HTML message to a chat with an optional
 *                         inline keyboard (URL buttons → trade links + token).
 *   - broadcastBurst()  — given a high-conviction burst, select the
 *                         telegram_subscriptions rows it matches (each chat's own
 *                         min_buyers / min_sol / holding_only / muted +
 *                         watched_wallets) and DM each of them the call with an
 *                         inline_keyboard of one-click trade links.
 *
 * REVENUE: the inline buttons are built from lib/trade-links.ts tokenLinks(),
 * which carries the env `?ref=` referral codes (NEXT_PUBLIC_REF_*) — every tap
 * is an attributed click on our referral, so per-user alerts monetize directly.
 *
 * Fully env-gated + resilient: a no-op when TELEGRAM_BOT_TOKEN or Supabase are
 * unset, never throws, and per-chat try/catch so one bad send never aborts the
 * fan-out.
 */

import { sendMessageTo, escapeHtml, type InlineKeyboard } from './notifier';
import { tokenLinks } from '../trade-links';
import { getSupabase, isSupabaseConfigured } from '../supabase-client';

// --- Anti-spam: cap how many chats we fan out to per burst per run. Telegram
// rate-limits ~30 msg/s for bots; we stay well under and rely on the next cron
// tick + dedupe to drain a large backlog. ---
const MAX_FANOUT = 200;

/** A subscription row, as persisted by 0015_telegram_subscriptions.sql. */
interface SubscriptionRow {
  chat_id: string;
  min_buyers: number | null;
  min_sol: number | null;
  holding_only: boolean | null;
  muted: boolean | null;
  watched_wallets: string[] | null;
}

/**
 * The minimal burst shape broadcastBurst needs. Mirrors the columns calls.ts
 * already reads from live_bursts (CallRow) plus the optional buyer wallet
 * sample + holders flag used for per-chat matching.
 */
export interface BurstForBroadcast {
  mint: string;
  symbol: string | null;
  buyers: number | null;
  sol_total: number | null;
  tiers: string[] | null;
  /** Sample of the buyer wallet addresses in this burst (for /watch matching). */
  sample_buyers?: string[] | null;
  pairAddress?: string | null;
  /** Whether this burst includes wallets that are still HOLDING the token. */
  holding?: boolean | null;
}

function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

function fmtSol(n: number | null | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  if (v >= 100) return Math.round(v).toString();
  return (Math.round(v * 100) / 100).toString();
}

// --- Token-text sanitizer (mirrors lib/alerts/calls.ts). On-chain token
// metadata is attacker-controlled; even though the Telegram path HTML-escapes,
// we still strip mentions/links/control chars so a malicious symbol can't ride
// our reach or smuggle markup, and hard-cap the length. ---
const MAX_SYMBOL_LEN = 24;

function sanitizeTokenText(raw: string | null | undefined): string {
  let s = String(raw ?? '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, ' ');
  s = s.replace(/\b(?:https?:\/\/|www\.)\S*/gi, ' ');
  s = s.replace(/\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?/gi, ' ');
  s = s.replace(/[@#＠＃]\S*/g, ' ');
  s = s.replace(/[^A-Za-z0-9 ._-]/g, ' ');
  s = s.replace(/\s+/g, ' ').replace(/^[ ._-]+|[ ._-]+$/g, '').trim();
  if (s.length > MAX_SYMBOL_LEN) s = s.slice(0, MAX_SYMBOL_LEN).trim();
  return s;
}

/** Display ticker: $SYM when known and safe, else a short mint. */
function ticker(symbol: string | null, mint: string): string {
  const safe = sanitizeTokenText((symbol ?? '').replace(/^\$/, ''));
  if (safe) return `$${safe}`;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function sTierCount(tiers: string[] | null | undefined): number {
  if (!Array.isArray(tiers)) return 0;
  return tiers.filter((t) => typeof t === 'string' && t.trim().toUpperCase() === 'S').length;
}

/**
 * Build the inline keyboard for a burst: a row (or rows) of one-click TRADE
 * buttons (carrying ref codes for revenue) followed by an "Open in app" button
 * to the token page. We lay the trade buttons out 3-per-row so the keyboard
 * stays compact on mobile.
 */
export function burstKeyboard(mint: string, pairAddress?: string | null): InlineKeyboard {
  const links = tokenLinks(mint, pairAddress ? { pairAddress } : undefined);
  const trades = links.filter((l) => l.kind === 'trade');

  const rows: InlineKeyboard = [];
  for (let i = 0; i < trades.length; i += 3) {
    rows.push(
      trades.slice(i, i + 3).map((l) => ({ text: `Ape · ${l.label}`, url: l.url }))
    );
  }
  rows.push([{ text: '📊 Open in app', url: `${appBaseUrl()}/token/${mint}` }]);
  return rows;
}

/**
 * Send one HTML message to a chat with an optional inline keyboard. Thin,
 * named wrapper over the notifier's sendMessageTo so callers (the webhook +
 * broadcastBurst) have a single bot-flavored entry point. Returns true on a
 * successful send. Env-gated + non-throwing via sendMessageTo/tgApi.
 */
export async function sendToChat(
  chatId: string,
  html: string,
  inlineKeyboard?: InlineKeyboard
): Promise<boolean> {
  return sendMessageTo(chatId, html, inlineKeyboard);
}

/**
 * Decide whether a chat's filters match a burst.
 *   - muted chats never match.
 *   - a watched-wallet hit ALWAYS matches (overrides the min_* thresholds),
 *     so a user tracking a specific wallet never misses its buys.
 *   - otherwise the burst must clear the chat's min_buyers AND min_sol, and —
 *     when holding_only is set — the burst must include holders.
 */
export function matchesSubscription(
  sub: SubscriptionRow,
  burst: BurstForBroadcast
): boolean {
  if (sub.muted) return false;

  const watched = Array.isArray(sub.watched_wallets) ? sub.watched_wallets : [];
  if (watched.length > 0) {
    const sample = Array.isArray(burst.sample_buyers) ? burst.sample_buyers : [];
    const watchSet = new Set(watched.map((w) => w.trim()).filter(Boolean));
    if (sample.some((w) => typeof w === 'string' && watchSet.has(w.trim()))) {
      return true;
    }
  }

  if (sub.holding_only && !burst.holding) return false;

  const buyers = typeof burst.buyers === 'number' ? burst.buyers : 0;
  const sol = typeof burst.sol_total === 'number' ? burst.sol_total : 0;
  const minBuyers = typeof sub.min_buyers === 'number' ? sub.min_buyers : 0;
  const minSol = typeof sub.min_sol === 'number' ? sub.min_sol : 0;

  return buyers >= minBuyers && sol >= minSol;
}

/**
 * Fan a high-conviction burst out to every subscriber whose filters match it.
 * Each matched chat gets a punchy HTML message + an inline_keyboard of trade
 * links (revenue-bearing) and an Open-in-app button.
 *
 * Returns the number of chats actually messaged. Safe no-op (returns 0) when
 * the bot token or Supabase are unconfigured; per-chat resilient so one failed
 * send never aborts the fan-out.
 */
export async function broadcastBurst(burst: BurstForBroadcast): Promise<{ sent: number }> {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { sent: 0 };
  if (!isSupabaseConfigured()) return { sent: 0 };
  if (!burst?.mint) return { sent: 0 };

  try {
    const supabase = getSupabase();
    const read = await supabase
      .from('telegram_subscriptions')
      .select('chat_id, min_buyers, min_sol, holding_only, muted, watched_wallets')
      .eq('muted', false)
      .limit(5000);

    if (read.error) {
      console.error('[TGBOT] broadcastBurst read failed:', read.error.message);
      return { sent: 0 };
    }

    const subs = (read.data ?? []) as SubscriptionRow[];
    const targets = subs.filter((s) => matchesSubscription(s, burst)).slice(0, MAX_FANOUT);
    if (targets.length === 0) return { sent: 0 };

    const sym = ticker(burst.symbol, burst.mint);
    const buyers = typeof burst.buyers === 'number' ? burst.buyers : 0;
    const sCount = sTierCount(burst.tiers);
    const sol = fmtSol(burst.sol_total);
    const sTag = sCount > 0 ? ` (${sCount} S-tier)` : '';

    const html =
      `🚨 <b>SMART MONEY APING ${escapeHtml(sym)}</b>\n` +
      `${buyers} wallets${escapeHtml(sTag)} just bought · ${escapeHtml(sol)}◎\n` +
      `Tap to ape 👇`;

    const keyboard = burstKeyboard(burst.mint, burst.pairAddress);

    let sent = 0;
    for (const sub of targets) {
      try {
        const ok = await sendToChat(sub.chat_id, html, keyboard);
        if (ok) sent++;
      } catch (err) {
        console.error('[TGBOT] broadcastBurst send failed:', (err as Error).message);
      }
    }
    return { sent };
  } catch (err) {
    console.error('[TGBOT] broadcastBurst crashed:', (err as Error).message);
    return { sent: 0 };
  }
}
