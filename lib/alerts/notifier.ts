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

/** POST one HTML message to a single Telegram chat. Returns true on res.ok. */
async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      // 429 / 5xx etc. — surface so the caller skips stamping the cooldown.
      console.error(
        `[ALERT] Telegram send to ${chatId} returned ${res.status} ${res.statusText}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error('[ALERT] Telegram send failed:', (error as Error).message);
    return false;
  }
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
