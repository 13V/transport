/**
 * ALERT NOTIFIER
 *
 * Fans an alert string out to whichever channels are configured:
 *   - Telegram private/ops chat (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID), HTML mode
 *   - Telegram public channel (TELEGRAM_BOT_TOKEN + TELEGRAM_PUBLIC_CHAT_ID),
 *     optional broadcast target — no-op when unset
 *   - A generic webhook (ALERT_WEBHOOK_URL), POSTed as { text }
 *
 * Env vars:
 *   - TELEGRAM_BOT_TOKEN     bot token for all Telegram sends
 *   - TELEGRAM_CHAT_ID       private/ops chat that receives every alert
 *   - TELEGRAM_PUBLIC_CHAT_ID  optional separate public channel/group; when set,
 *                            alerts ALSO broadcast here. No-op/passthrough unset.
 *   - ALERT_WEBHOOK_URL      optional generic webhook, receives { text }
 *
 * Degrades gracefully: a no-op when nothing is configured, and never throws —
 * a failed alert must never take down the cron that triggered it.
 *
 * IMPORTANT (data-loss fix): sendAlert reports whether the Telegram send
 * actually SUCCEEDED (res.ok). Callers must only stamp a cooldown / mark an
 * alert as sent when this returns true; on a 429/5xx the message is dropped and
 * we want the next cron tick to retry rather than losing the alert forever.
 */

/** Escape a raw string for safe interpolation into a Telegram HTML message. */
export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A single Telegram inline-keyboard button (URL buttons + callback buttons). */
export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

/** A Telegram inline keyboard: rows of buttons. */
export type InlineKeyboard = InlineButton[][];

/** Parsed Telegram Bot API response envelope. */
export interface TgApiResult {
  ok: boolean;
  result?: unknown;
  description?: string;
}

/**
 * Low-level Telegram Bot API call. Posts `payload` as JSON to the given Bot API
 * `method` (e.g. 'sendMessage', 'answerCallbackQuery', 'setWebhook') and returns
 * the parsed `{ ok, result?, description? }` envelope, or `null` when the bot
 * token is unset (env-gated no-op) or the request throws. Never throws — a
 * failed Telegram call must never take down the caller.
 */
export async function tgApi(
  method: string,
  payload: Record<string, unknown>
): Promise<TgApiResult | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let json: TgApiResult | null = null;
    try {
      json = (await res.json()) as TgApiResult;
    } catch {
      json = null;
    }
    if (!res.ok || !json?.ok) {
      console.error(
        `[ALERT] Telegram ${method} returned ${res.status} ${res.statusText}` +
          (json?.description ? ` — ${json.description}` : '')
      );
      return json ?? { ok: false };
    }
    return json;
  } catch (error) {
    console.error(`[ALERT] Telegram ${method} failed:`, (error as Error).message);
    return null;
  }
}

/**
 * Send ONE HTML message to a single chat, with an optional inline keyboard.
 * Returns true only when Telegram acknowledged the send (so callers can gate a
 * cooldown / retry on false). No-op success is NOT implied here — when the token
 * is unset tgApi returns null and we return false.
 */
export async function sendMessageTo(
  chatId: string,
  html: string,
  inlineKeyboard?: InlineKeyboard
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (inlineKeyboard && inlineKeyboard.length > 0) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  const res = await tgApi('sendMessage', payload);
  return Boolean(res?.ok);
}

/**
 * POST one HTML message to a single Telegram chat. Returns true on success.
 * Thin wrapper over {@link sendMessageTo} (the shared tgApi path) so the
 * broadcast functions below and the inbound bot share one code path. The
 * `token` arg is retained for call-site compatibility but the token is read
 * from env inside tgApi; callers only reach here when it is set.
 */
async function sendTelegram(_token: string, chatId: string, text: string): Promise<boolean> {
  return sendMessageTo(chatId, text);
}

/**
 * Send an alert to every configured channel.
 *
 * Returns `true` only when delivery to the PRIMARY (private/ops) Telegram chat
 * succeeded, OR when Telegram isn't configured at all (no-op success — there is
 * nothing to retry, matching today's degrade-to-no-op behaviour). The optional
 * public channel and the webhook are best-effort and never gate the return value
 * so a flaky public broadcast can't block the primary cooldown.
 *
 * Callers should treat `false` as "not delivered — do NOT stamp the cooldown;
 * retry next tick".
 */
export async function sendAlert(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const publicChatId = process.env.TELEGRAM_PUBLIC_CHAT_ID;
  const webhook = process.env.ALERT_WEBHOOK_URL;

  // No primary Telegram chat configured: degrade to no-op success (as today),
  // but still fire the optional public channel / webhook if those are set.
  let primaryOk = true;

  if (token && chatId) {
    primaryOk = await sendTelegram(token, chatId, text);
  }

  // Optional public broadcast — best-effort, never gates the return value.
  if (token && publicChatId) {
    await sendTelegram(token, publicChatId, text);
  }

  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (error) {
      console.error('[ALERT] Webhook send failed:', (error as Error).message);
    }
  }

  return primaryOk;
}
