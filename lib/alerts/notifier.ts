/**
 * ALERT NOTIFIER
 *
 * Fans an alert string out to whichever channels are configured:
 *   - Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID), HTML parse mode
 *   - A generic webhook (ALERT_WEBHOOK_URL), POSTed as { text }
 *
 * Degrades gracefully: a no-op when nothing is configured, and never throws —
 * a failed alert must never take down the cron that triggered it.
 */

/** Escape a raw string for safe interpolation into a Telegram HTML message. */
export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const webhook = process.env.ALERT_WEBHOOK_URL;

  if (token && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
    } catch (error) {
      console.error('[ALERT] Telegram send failed:', (error as Error).message);
    }
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
}
