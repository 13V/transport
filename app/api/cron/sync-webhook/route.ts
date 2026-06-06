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
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { getSmartCriteria, isSmartWallet } from '../../../../lib/indexer/curation';
import { fetchAllRows } from '../../../../lib/db-paginate';
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

/** Resolve the FULL set of smart-wallet addresses (raw, NOT cluster-deduped). */
async function resolveSmartAddresses(): Promise<{ addresses: string[]; error: string | null }> {
  const supabase = getSupabase();
  const criteria = getSmartCriteria();
  const now = Date.now();

  // Push the cheap gate conditions into the query so only plausible-smart rows
  // come back; the remaining nuance (bot-filter, maxWinRate, idle) is applied in
  // JS via isSmartWallet so the set is byte-identical to /api/status. Mirror that
  // route exactly. Build a FRESH query per page (Supabase builders are single-use).
  const cols =
    'wallet, score, realized_pnl, win_rate, consistency, total_trades, tokens_traded, last_trade_at';
  const buildGate = () => {
    let qb = supabase
      .from('wallet_stats')
      .select(`${cols}, seeded, roi_pct, invested_sol, verified`)
      .not('roi_pct', 'is', null)
      .gte('roi_pct', criteria.minRoiPct)
      .gte('realized_pnl', criteria.minPnlSol)
      .gte('total_trades', criteria.minTrades)
      .gte('tokens_traded', criteria.minTokens);
    if (criteria.minInvestedSol > 0) {
      qb = qb.gte('invested_sol', criteria.minInvestedSol);
    }
    if (criteria.maxIdleDays > 0) {
      const cutoff = new Date(now - criteria.maxIdleDays * 86_400_000).toISOString();
      qb = qb.gte('last_trade_at', cutoff);
    }
    return qb.order('score', { ascending: false });
  };

  const extRead = await fetchAllRows(buildGate);
  if (extRead.error) {
    return { addresses: [], error: extRead.error.message };
  }

  const addresses = (extRead.data ?? [])
    .filter((r: any) =>
      isSmartWallet(
        {
          realizedPnl: Number(r.realized_pnl),
          roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
          investedSol: r.invested_sol == null ? null : Number(r.invested_sol),
          winRate: Number(r.win_rate),
          totalTrades: Number(r.total_trades),
          tokensTraded: Number(r.tokens_traded),
          lastTradeAt: r.last_trade_at,
          seeded: Boolean(r.seeded),
        },
        criteria,
        now
      )
    )
    .map((r: any) => String(r.wallet));

  return { addresses, error: null };
}

export async function GET(request: NextRequest) {
  // CRON_SECRET auth — only enforced when the secret is configured.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
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
