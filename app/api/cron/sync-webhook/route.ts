/**
 * SYNC HELIUS WEBHOOK CRON ENDPOINT
 *
 * Keeps a single Helius "enhanced" SWAP webhook's subscribed-address list in
 * sync with our current smart-wallet set, so the real-time receiver
 * (`/api/helius/webhook`) gets pushed every smart-wallet swap.
 *
 *   GET /api/cron/sync-webhook
 *
 * Self-registering: on the FIRST run (no stored webhook id) it CREATES the
 * webhook and persists its id to `indexer_state` (key `helius_webhook_id`). On
 * every subsequent run it EDITS that webhook's address list. If the stored id
 * has gone stale (Helius returns 404), it falls back to creating a fresh one.
 *
 * Resilient: env/Helius problems are reported in the JSON body with a 200 so
 * cron-job.org logs a clean run instead of retrying a hard failure.
 *
 * Driven by cron-job.org roughly every 30 minutes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cronAuthFails } from '../../../../lib/cron-auth';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { getSmartWalletSet } from '../../../../lib/indexer/live-bursts';
import {
  createWebhook,
  editWebhook,
  listWebhooks,
  deleteWebhook,
  isNotFound,
  MAX_ADDRESSES,
  type HeliusWebhook,
} from '../../../../lib/helius/webhook-admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const WEBHOOK_ID_KEY = 'helius_webhook_id';

/**
 * Compare two receiver URLs for "same webhook target". Helius stores the URL it
 * was registered with verbatim, so normalize via the URL parser (host casing,
 * default ports) and ignore a single trailing slash on the path before an exact
 * compare. Falls back to a trimmed string equality if either fails to parse.
 */
function sameWebhookUrl(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (u: string): string => {
    try {
      const url = new URL(u);
      const path = url.pathname.replace(/\/+$/, '');
      return `${url.protocol}//${url.host}${path}${url.search}`;
    } catch {
      return u.trim().replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}

/**
 * Resolve the FULL set of smart-wallet addresses (raw, NOT cluster-deduped) to
 * register on the Helius webhook.
 *
 * COST: this used to run a paginated FULL-TABLE gate scan of wallet_stats every
 * 30-min run (mirroring /api/status). It now reuses getSmartWalletSet() — the
 * SAME in-process-memoized gated smart-wallet set that already drives the live
 * feed and the webhook receiver's attribution — so the cron stops doing its own
 * scan and instead shares the cached resolution (often a 0-query cache hit).
 *
 * EQUIVALENCE: getSmartWalletSet().wallets is the set of wallets for which
 * isSmartWallet(...) holds under getSmartCriteria() — exactly the gate the old
 * scan applied in JS. The only implementation nuance: the old scan prefiltered
 * the query by `roi_pct not null` + gte thresholds, while resolveSmartSet
 * prefilters by `verified=true`; for non-seeded wallets these select the same
 * population because isSmartWallet itself requires roi_pct != null (= verified)
 * plus the identical thresholds, so the authoritative JS filter yields the same
 * addresses. Adopting getSmartWalletSet() also makes the addresses synced to
 * Helius consistent with the exact set used for ingest attribution + alerts.
 *
 * Over-cap ordering: the old scan ordered by score desc so MAX_ADDRESSES
 * truncation kept the highest-score wallets. The cached set is an unordered Set,
 * so we sort by the set's scoreByWallet map (desc) here to preserve that
 * "keep highest-score" truncation behavior.
 */
async function resolveSmartAddresses(): Promise<{ addresses: string[]; error: string | null }> {
  try {
    const { wallets, scoreByWallet } = await getSmartWalletSet();
    const addresses = Array.from(wallets).sort(
      (a, b) => (scoreByWallet.get(b) ?? 0) - (scoreByWallet.get(a) ?? 0)
    );
    return { addresses, error: null };
  } catch (err) {
    return { addresses: [], error: (err as Error).message };
  }
}

export async function GET(request: NextRequest) {
  // CRON_SECRET auth — FAILS CLOSED (unset secret or mismatch → 401).
  if (cronAuthFails(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const noStore = { headers: { 'Cache-Control': 'no-store' } };

  // Required env — report clearly (200, no throw) so cron logs a clean run.
  const apiKey = process.env.HELIUS_API_KEY;
  const webhookSecret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!apiKey || !webhookSecret) {
    const missing = [!apiKey && 'HELIUS_API_KEY', !webhookSecret && 'HELIUS_WEBHOOK_SECRET']
      .filter(Boolean)
      .join(', ');
    return NextResponse.json(
      { ok: false, error: `${missing} env missing` },
      noStore
    );
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, error: 'Supabase not configured' }, noStore);
  }

  // Derive the receiver URL. Prefer an explicit override; otherwise use the
  // request origin — but only over https (guard against localhost/preview, where
  // Helius could not reach us anyway).
  let webhookURL: string;
  const override = process.env.WEBHOOK_BASE_URL;
  if (override) {
    webhookURL = new URL('/api/helius/webhook', override).toString();
  } else {
    const origin = request.nextUrl.origin;
    if (!origin.startsWith('https://')) {
      return NextResponse.json(
        {
          ok: false,
          error: `Refusing to register a non-https receiver URL (origin: ${origin}). Set WEBHOOK_BASE_URL to a public https URL.`,
        },
        noStore
      );
    }
    webhookURL = new URL('/api/helius/webhook', origin).toString();
  }

  // Resolve the full smart-wallet address set.
  const { addresses, error: addrError } = await resolveSmartAddresses();
  if (addrError) {
    return NextResponse.json(
      { ok: false, error: `Failed to resolve smart wallets: ${addrError}` },
      noStore
    );
  }

  // Defensive truncation under Helius' per-webhook address cap.
  const truncated = addresses.length > MAX_ADDRESSES;
  const accountAddresses = truncated ? addresses.slice(0, MAX_ADDRESSES) : addresses;

  const supabase = getSupabase();
  const cfg = { webhookURL, accountAddresses, authHeader: webhookSecret };

  // Read the stored webhook id (if any) so we know whether to create or update.
  let storedId: string | null = null;
  try {
    const { data } = await supabase
      .from('indexer_state')
      .select('value')
      .eq('key', WEBHOOK_ID_KEY)
      .maybeSingle();
    const v = (data as any)?.value;
    if (typeof v === 'string') storedId = v;
    else if (v && typeof v === 'object' && typeof v.webhookId === 'string') storedId = v.webhookId;
  } catch {
    storedId = null;
  }

  /** Persist a freshly-created webhook id to indexer_state. */
  async function persistId(id: string) {
    await supabase.from('indexer_state').upsert(
      {
        key: WEBHOOK_ID_KEY,
        value: { webhookId: id },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );
  }

  try {
    let action: 'created' | 'updated';
    let webhookId: string;
    let cleanedUp = 0;

    // RECONCILE BY URL — defend against duplicate webhooks. If the stored-id read
    // ever failed (or the id went stale and a previous run created a second one),
    // a blind create would register a SECOND webhook for the same receiver URL →
    // every swap delivered twice (doubled Helius credit burn + duplicate
    // processing). So before we create/update, ask Helius what already exists for
    // OUR derived URL and converge to exactly one. listWebhooks failing must not
    // block the run, so treat it as "no matches known" and fall back.
    let urlMatches: HeliusWebhook[] = [];
    try {
      const all = await listWebhooks();
      urlMatches = all.filter((w) => sameWebhookUrl(w.webhookURL, webhookURL));
    } catch (err) {
      console.error('[CRON] sync-webhook listWebhooks failed (continuing):', err);
      urlMatches = [];
    }

    if (urlMatches.length > 0) {
      // Keep the first match (prefer the stored id if it's among them so the
      // persisted pointer stays stable), update it to the current config, and
      // DELETE every other webhook pointing at our URL.
      const preferred =
        (storedId && urlMatches.find((w) => w.webhookID === storedId)) || urlMatches[0];
      const keepId = preferred.webhookID;

      const wh = await editWebhook(keepId, cfg);
      action = 'updated';
      webhookId = (wh.webhookID as string) || keepId;

      for (const dup of urlMatches) {
        if (dup.webhookID === keepId) continue;
        try {
          await deleteWebhook(dup.webhookID);
          cleanedUp++;
        } catch (err) {
          // A duplicate that 404s is already gone — count it as cleaned. Any
          // other delete error: log and keep going so one bad delete doesn't
          // abort the whole reconcile.
          if (isNotFound(err)) {
            cleanedUp++;
          } else {
            console.error(`[CRON] sync-webhook failed to delete duplicate ${dup.webhookID}:`, err);
          }
        }
      }

      // Persist the id we kept — covers the case where the stored id was missing
      // or pointed at a now-deleted duplicate.
      if (webhookId !== storedId) await persistId(webhookId);
    } else if (storedId) {
      // No URL match found via list (e.g. list failed) but we have a stored id —
      // try to edit it; recreate only on a definitive 404.
      try {
        const wh = await editWebhook(storedId, cfg);
        action = 'updated';
        webhookId = (wh.webhookID as string) || storedId;
      } catch (err) {
        if (isNotFound(err)) {
          const wh = await createWebhook(cfg);
          webhookId = wh.webhookID;
          await persistId(webhookId);
          action = 'created';
        } else {
          throw err;
        }
      }
    } else {
      // Nothing exists for our URL and no stored id → first-run create.
      const wh = await createWebhook(cfg);
      webhookId = wh.webhookID;
      await persistId(webhookId);
      action = 'created';
    }

    return NextResponse.json(
      {
        ok: true,
        action,
        webhookId,
        cleanedUpDuplicates: cleanedUp,
        addressCount: accountAddresses.length,
        webhookURL,
        truncated,
      },
      noStore
    );
  } catch (error) {
    console.error('[CRON] sync-webhook failed:', error);
    return NextResponse.json(
      { ok: false, error: (error as Error).message, webhookURL, addressCount: accountAddresses.length, truncated },
      noStore
    );
  }
}
