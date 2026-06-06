/**
 * WEB-PUSH FAN-OUT
 *
 * Sends browser/desktop push notifications to every opted-in web subscriber so
 * they get real-time smart-money burst alerts without Telegram. Subscriptions
 * are stored in `push_subscriptions` (see supabase/migrations/0006) and created
 * client-side via the 🔔 Alerts button in the Live feed.
 *
 * VAPID auth is configured from env:
 *   VAPID_PUBLIC_KEY   — public application server key (also exposed to the
 *                        browser as NEXT_PUBLIC_VAPID_PUBLIC_KEY for subscribe)
 *   VAPID_PRIVATE_KEY  — private signing key (server-only, NEVER exposed)
 *   VAPID_SUBJECT      — contact URI, e.g. 'mailto:you@example.com'
 *
 * RESILIENT BY DESIGN: missing env or no subscribers is a silent no-op, and a
 * push failure never throws. Dead subscriptions (404/410 Gone) are pruned so the
 * table self-heals. Alerting must NEVER affect ingestion.
 */

import webpush from 'web-push';
import { getSupabase, isSupabaseConfigured } from './supabase-client';

export interface WebPushPayload {
  title: string;
  body: string;
  url: string;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** True only when all three VAPID env vars are present. */
function isVapidConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT
  );
}

let vapidReady = false;

/** Lazily wire web-push with the VAPID details once. Safe to call repeatedly. */
function ensureVapid(): boolean {
  if (!isVapidConfigured()) return false;
  if (!vapidReady) {
    try {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT!,
        process.env.VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!
      );
      vapidReady = true;
    } catch (error) {
      console.error('[PUSH] Failed to set VAPID details:', (error as Error).message);
      return false;
    }
  }
  return true;
}

/** Public VAPID key for the client (applicationServerKey). null when unset. */
export function getPublicVapidKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

/**
 * Send a push payload to ALL stored subscriptions. Best-effort and resilient:
 *   - no VAPID env / no Supabase / no subscribers → silent no-op
 *   - per-subscription failure is logged, not thrown
 *   - 404 / 410 (Gone) prunes that dead subscription so the table self-heals
 * Never throws.
 */
export async function sendWebPushToAll(payload: WebPushPayload): Promise<void> {
  try {
    if (!ensureVapid() || !isSupabaseConfigured()) return;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth');

    if (error || !data || data.length === 0) return;

    const json = JSON.stringify(payload);
    const dead: string[] = [];

    await Promise.all(
      (data as SubscriptionRow[]).map(async (row) => {
        if (!row.endpoint || !row.p256dh || !row.auth) return;
        const subscription = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        };
        try {
          await webpush.sendNotification(subscription, json);
        } catch (err) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            dead.push(row.endpoint);
          } else {
            console.error(
              '[PUSH] send failed for endpoint:',
              status ?? (err as Error).message
            );
          }
        }
      })
    );

    if (dead.length > 0) {
      try {
        await supabase.from('push_subscriptions').delete().in('endpoint', dead);
      } catch (err) {
        console.error('[PUSH] failed to prune dead subscriptions:', (err as Error).message);
      }
    }
  } catch (error) {
    // Alerting must NEVER affect ingestion.
    console.error('[PUSH] sendWebPushToAll failed:', (error as Error).message);
  }
}
