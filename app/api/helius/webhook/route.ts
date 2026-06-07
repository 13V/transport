/**
 * HELIUS ENHANCED-WEBHOOK INGESTION ENDPOINT
 *
 * Real-time (sub-second) trade ingestion for our subscribed smart wallets.
 * Helius POSTs a JSON ARRAY of enriched transactions here; we parse the
 * SOL<->token swaps and upsert them into `trades` so the Live feed / alerts
 * fire within seconds. This replaces polling for the subscribed set.
 *
 * SECURITY — FAILS CLOSED. This is a PUBLIC POST endpoint that writes to
 * `trades`. Without auth, anyone could inject fake trades → fake bursts. So:
 *   - HELIUS_WEBHOOK_SECRET MUST be set, AND
 *   - the request's `Authorization` header MUST equal it exactly
 *     (Helius sends the configured authHeader value verbatim).
 * If the env is unset OR the header mismatches → 401. No exceptions.
 *
 * RESILIENCE: never 5xx on a single bad tx (Helius retries slow/failing
 * webhooks). We parse defensively, upsert in chunks, and always return fast.
 */

import { NextRequest, NextResponse, after } from 'next/server';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { parseHeliusSwaps } from '../../../../lib/helius/parse-swap';
import {
  getSmartWalletSet,
  detectBurstsForMints,
  type LiveBurst,
} from '../../../../lib/indexer/live-bursts';
import { readCooldowns, writeCooldowns } from '../../../../lib/alerts/cooldowns';
import { sendAlert, escapeHtml } from '../../../../lib/alerts/notifier';
import { sendWebPushToAll, sendWebPushToOwner } from '../../../../lib/push';
import { tokenLinks } from '../../../../lib/trade-links';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CHUNK = 500;

// Real-time burst-alert cooldown blob (mint -> last-alert epoch-ms).
const BURST_COOLDOWN_KEY = 'alert_cooldowns_burst';
// Separate cooldown blob for sell/exit bursts so they never share suppression
// with buy bursts (a token can fire a buy burst and later an exit burst).
const SELL_BURST_COOLDOWN_KEY = 'alert_cooldowns_sell_burst';
// Per-user watchlist push de-dup, keyed `${owner}:${mint}` -> last-push ms.
const WATCH_COOLDOWN_KEY = 'alert_cooldowns_watch';

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

function fmtSol(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 100) return Math.round(n).toString();
  return (Math.round(n * 100) / 100).toString();
}

/** Short, human-friendly wallet form, e.g. "9xQa…7kPz". */
function shortWallet(w: string): string {
  if (!w || w.length <= 10) return w;
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

/** "2×S · 1×A" style summary of the tiers present in a burst. */
function tierMix(tiers: (string | null)[]): string {
  const counts = new Map<string, number>();
  for (const t of tiers) {
    const tier = t ?? '?';
    counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  const order = ['S', 'A', 'B', 'C', '?'];
  return [...counts.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([tier, n]) => `${n}×${tier}`)
    .join(' · ');
}

/**
 * Real-time smart-money BURST alerts for the mints just ingested. Runs AFTER the
 * 200 response (via `next/server` `after`) so it never blocks or slows ingest.
 * A higher quality bar than the live feed: enough buyers, real SOL size, and an
 * S-tier present (unless disabled). Per-mint cooldown, stamped only on delivery.
 * Wrapped so any failure is swallowed — alerting must never affect ingestion.
 */
async function runBurstAlerts(touchedMints: string[]): Promise<void> {
  try {
    const mints = Array.from(
      new Set(touchedMints.filter((m) => typeof m === 'string' && m))
    );
    if (mints.length === 0 || !isSupabaseConfigured()) return;

    const minBuyers = envInt('ALERT_BURST_MIN_BUYERS', 4);
    const minSol = envNum('ALERT_BURST_MIN_SOL', 5);
    const requireS = process.env.ALERT_BURST_REQUIRE_S !== '0';
    const cooldownMin = envInt('ALERT_BURST_COOLDOWN_MIN', 30);
    const cooldownMs = cooldownMin * 60_000;
    const now = Date.now();

    const bursts = await detectBurstsForMints(mints, {
      windowSec: 30,
      minBuyers,
    });

    // PER-USER WATCHLIST PUSH — fires for ANY detected buy burst (even below the
    // broadcast bar), since each such user explicitly opted into that wallet.
    // Runs off the SAME detected bursts; one watchlists query per batch.
    await runWatchlistPush(bursts, now);

    // QUALITY GATE — higher bar than the feed.
    const qualified = bursts.filter((b: LiveBurst) => {
      if (b.buyers < minBuyers) return false;
      if (b.solTotal < minSol) return false;
      if (requireS && !b.tiers.some((t) => t === 'S')) return false;
      return true;
    });
    if (qualified.length === 0) return;

    // Keep the best (most buyers, then most SOL) burst per mint.
    const bestByMint = new Map<string, LiveBurst>();
    for (const b of qualified) {
      const cur = bestByMint.get(b.mint);
      if (!cur || b.buyers > cur.buyers || (b.buyers === cur.buyers && b.solTotal > cur.solTotal)) {
        bestByMint.set(b.mint, b);
      }
    }

    const cooldowns = await readCooldowns(BURST_COOLDOWN_KEY);
    let stamped = false;

    for (const [mint, b] of bestByMint) {
      const last = cooldowns[mint];
      if (typeof last === 'number' && now - last < cooldownMs) continue; // cooling

      const symbol = b.symbol ? `$${b.symbol}` : `${mint.slice(0, 6)}…`;
      const mix = tierMix(b.tiers);
      const trade = tokenLinks(mint).find((l) => l.kind === 'trade');
      const link = trade
        ? `\n<a href="${escapeHtml(trade.url)}">${escapeHtml(trade.label)}</a>`
        : '';
      const text =
        `🚨 <b>${escapeHtml(symbol)}</b> — ${b.buyers} smart wallets (${escapeHtml(mix)}) ` +
        `bought ${fmtSol(b.solTotal)} SOL within 30s` +
        `\n<code>${escapeHtml(mint)}</code>` +
        link;

      try {
        const delivered = await sendAlert(text);
        if (delivered) {
          cooldowns[mint] = now; // stamp ONLY on confirmed delivery
          stamped = true;
        }
        // On !delivered, leave the cooldown unset so a later tick can retry.
      } catch (error) {
        console.error('[HELIUS WEBHOOK] burst alert send failed for', mint, (error as Error).message);
      }

      // WEB PUSH: fan out the SAME gated burst to opted-in browser/desktop
      // subscribers (no Telegram needed). Reuses the per-mint cooldown above
      // (we're already inside it), so this can't double-send. Wrapped + the
      // helper is itself no-throw, so a push failure never affects ingestion
      // or the Telegram path.
      try {
        await sendWebPushToAll({
          title: `🚨 ${symbol}`,
          body: `${b.buyers} smart wallets bought ${fmtSol(b.solTotal)} SOL in 30s`,
          url: `/token/${mint}`,
        });
      } catch (error) {
        console.error('[HELIUS WEBHOOK] web push send failed for', mint, (error as Error).message);
      }
    }

    if (stamped) await writeCooldowns(BURST_COOLDOWN_KEY, cooldowns);

    // EXIT / SELL-BURST ALERTS — distinct broadcast, separate cooldown blob.
    await runSellBurstAlerts(mints, now);
  } catch (error) {
    // Alerting must NEVER affect ingestion.
    console.error('[HELIUS WEBHOOK] burst alert step failed:', (error as Error).message);
  }
}

/**
 * EXIT / SELL-BURST broadcast: detects ≥N distinct smart-money ENTITIES SELLING
 * the same token within the window and, when the gate passes (min entities + min
 * SOL), broadcasts a distinct "smart money EXITING" alert via Telegram + web
 * push. Uses a SEPARATE per-mint cooldown blob so it never collides with buy
 * bursts. Env-gated; mirrors the buy path's stamp-on-delivery + try/catch
 * isolation. Wrapped so any failure is swallowed.
 */
async function runSellBurstAlerts(mints: string[], now: number): Promise<void> {
  try {
    if (process.env.ALERT_SELL_BURSTS === '0') return;

    const minEntities = envInt('ALERT_SELL_MIN_ENTITIES', 3);
    const minSol = envNum('ALERT_SELL_MIN_SOL', 5);
    const cooldownMin = envInt('ALERT_SELL_COOLDOWN_MIN', 30);
    const cooldownMs = cooldownMin * 60_000;

    const bursts = await detectBurstsForMints(mints, {
      windowSec: 30,
      minBuyers: minEntities,
      side: 'sell',
    });

    // GATE — min entities + real SOL size.
    const qualified = bursts.filter((b: LiveBurst) => {
      if (b.buyers < minEntities) return false;
      if (b.solTotal < minSol) return false;
      return true;
    });
    if (qualified.length === 0) return;

    // Keep the strongest exit (most entities, then most SOL) per mint.
    const bestByMint = new Map<string, LiveBurst>();
    for (const b of qualified) {
      const cur = bestByMint.get(b.mint);
      if (!cur || b.buyers > cur.buyers || (b.buyers === cur.buyers && b.solTotal > cur.solTotal)) {
        bestByMint.set(b.mint, b);
      }
    }

    const cooldowns = await readCooldowns(SELL_BURST_COOLDOWN_KEY);
    let stamped = false;

    for (const [mint, b] of bestByMint) {
      const last = cooldowns[mint];
      if (typeof last === 'number' && now - last < cooldownMs) continue; // cooling

      const symbol = b.symbol ? `$${b.symbol}` : `${mint.slice(0, 6)}…`;
      const trade = tokenLinks(mint).find((l) => l.kind === 'trade');
      const link = trade
        ? `\n<a href="${escapeHtml(trade.url)}">${escapeHtml(trade.label)}</a>`
        : '';
      const text =
        `🔴 <b>Smart money EXITING ${escapeHtml(symbol)}</b> — ${b.buyers} entities ` +
        `sold ${fmtSol(b.solTotal)} SOL in 30s` +
        `\n<code>${escapeHtml(mint)}</code>` +
        link;

      try {
        const delivered = await sendAlert(text);
        if (delivered) {
          cooldowns[mint] = now; // stamp ONLY on confirmed delivery
          stamped = true;
        }
      } catch (error) {
        console.error('[HELIUS WEBHOOK] sell-burst alert send failed for', mint, (error as Error).message);
      }

      try {
        await sendWebPushToAll({
          title: `🔴 Smart money exiting ${symbol}`,
          body: `${b.buyers} entities sold ${fmtSol(b.solTotal)} SOL in 30s`,
          url: `/token/${mint}`,
        });
      } catch (error) {
        console.error('[HELIUS WEBHOOK] sell-burst web push failed for', mint, (error as Error).message);
      }
    }

    if (stamped) await writeCooldowns(SELL_BURST_COOLDOWN_KEY, cooldowns);
  } catch (error) {
    console.error('[HELIUS WEBHOOK] sell-burst alert step failed:', (error as Error).message);
  }
}

/**
 * PER-USER WATCHLIST PUSH: for the given detected BUY bursts, find owners who
 * watch any wallet present in a burst and push them a personal alert. One
 * watchlists query per webhook batch (NOT per burst). De-duped per (owner, mint)
 * via a cooldown blob, and muted owners (alert_prefs.muted) are skipped.
 * Wrapped so any failure is swallowed.
 */
async function runWatchlistPush(bursts: LiveBurst[], now: number): Promise<void> {
  try {
    if (bursts.length === 0 || !isSupabaseConfigured()) return;

    // Collect the full distinct wallet set across all bursts.
    const allWallets = new Set<string>();
    for (const b of bursts) for (const w of b.wallets ?? []) allWallets.add(w);
    if (allWallets.size === 0) return;

    const supabase = getSupabase();

    // ONE query: which owners watch any wallet in these bursts.
    const { data: watchRows, error: watchErr } = await supabase
      .from('watchlists')
      .select('owner_id, address')
      .in('address', Array.from(allWallets));
    if (watchErr || !watchRows || watchRows.length === 0) return;

    // wallet -> owners watching it.
    const ownersByWallet = new Map<string, Set<string>>();
    const owners = new Set<string>();
    for (const r of watchRows as { owner_id: string; address: string }[]) {
      if (!r.owner_id || !r.address) continue;
      owners.add(r.owner_id);
      let set = ownersByWallet.get(r.address);
      if (!set) {
        set = new Set();
        ownersByWallet.set(r.address, set);
      }
      set.add(r.owner_id);
    }
    if (owners.size === 0) return;

    // Honor mutes: fetch muted owners among the matched set (best-effort).
    const muted = new Set<string>();
    try {
      const { data: prefRows } = await supabase
        .from('alert_prefs')
        .select('owner_id, muted')
        .in('owner_id', Array.from(owners));
      for (const p of (prefRows ?? []) as { owner_id: string; muted: boolean }[]) {
        if (p.muted) muted.add(p.owner_id);
      }
    } catch {
      // alert_prefs missing / pre-migration → treat all as unmuted.
    }

    const cooldownMs = envInt('ALERT_WATCH_COOLDOWN_MIN', 30) * 60_000;
    const cooldowns = await readCooldowns(WATCH_COOLDOWN_KEY);
    let stamped = false;

    for (const b of bursts) {
      const mint = b.mint;
      const symbol = b.symbol ? `$${b.symbol}` : `${mint.slice(0, 6)}…`;
      // Map each matched (owner, wallet) so the body names the watched wallet.
      for (const w of b.wallets ?? []) {
        const ownerSet = ownersByWallet.get(w);
        if (!ownerSet) continue;
        for (const owner of ownerSet) {
          if (muted.has(owner)) continue;
          const ckey = `${owner}:${mint}`;
          const last = cooldowns[ckey];
          if (typeof last === 'number' && now - last < cooldownMs) continue;
          // Stamp first so multiple matching wallets for one (owner, mint) only
          // push once per batch.
          cooldowns[ckey] = now;
          stamped = true;
          try {
            await sendWebPushToOwner(owner, {
              title: '⭐ Watched wallet just bought',
              body: `${shortWallet(w)} aped ${symbol} — ${fmtSol(b.solTotal)} SOL`,
              url: `/token/${mint}`,
            });
          } catch (error) {
            console.error('[HELIUS WEBHOOK] watchlist push failed for', owner, (error as Error).message);
          }
        }
      }
    }

    if (stamped) await writeCooldowns(WATCH_COOLDOWN_KEY, cooldowns);
  } catch (error) {
    console.error('[HELIUS WEBHOOK] watchlist push step failed:', (error as Error).message);
  }
}

/**
 * Smart-wallet address set for correct webhook attribution. getSmartWalletSet()
 * is already in-process memoized (short TTL, coalesced in-flight) by lib/indexer/
 * live-bursts, so this is a thin no-throw wrapper — NO second cache layer here
 * (that would just duplicate bookkeeping for the same set). Degrades to an empty
 * set on failure so the caller falls back to feePayer trust rather than dropping
 * trades.
 */
async function getSubscribedWallets(): Promise<Set<string>> {
  try {
    const { wallets } = await getSmartWalletSet();
    return wallets;
  } catch {
    return new Set();
  }
}

export async function POST(request: NextRequest) {
  // ---- Auth: FAIL CLOSED. ----
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) {
    // No secret configured → refuse to accept any write. Unauthenticated
    // writes to `trades` would let anyone fabricate trades.
    return NextResponse.json(
      { error: 'Webhook secret not configured' },
      { status: 401 }
    );
  }
  const auth = request.headers.get('authorization');
  if (auth !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ---- Parse body (expected: array of enriched txs). ----
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    // Malformed JSON: 200 no-op so Helius doesn't hammer retries.
    return NextResponse.json({ ok: true, parsed: 0, written: 0 });
  }

  // Attribute to OUR wallets only: resolve the subscribed smart-wallet set
  // (memoized) and pass it so the parser doesn't trust a relayer/counterparty
  // feePayer. Degrades to undefined (feePayer trust) only if resolution is
  // empty, preserving prior behavior rather than dropping every trade.
  const wallets = await getSubscribedWallets();
  const rows = parseHeliusSwaps(payload, wallets.size > 0 ? wallets : undefined);
  const parsed = rows.length;

  // If Supabase isn't configured, no-op (don't crash, don't fabricate).
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, parsed, written: 0 });
  }

  if (parsed === 0) {
    return NextResponse.json({ ok: true, parsed: 0, written: 0 });
  }

  const supabase = getSupabase();
  let written = 0;

  // Chunked upsert mirroring lib/indexer/run-indexer.ts. Dedup via the unique
  // constraint (tx_hash, wallet, token_mint, trade_type) — ignoreDuplicates so
  // the same tx delivered twice (Helius retries) is idempotent.
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      const { error } = await supabase
        .from('trades')
        .upsert(chunk, {
          onConflict: 'tx_hash,wallet,token_mint,trade_type',
          ignoreDuplicates: true,
        });
      if (error) {
        console.error('[HELIUS WEBHOOK] upsert trades failed:', error.message);
        continue; // keep other chunks; never 5xx
      }
      written += chunk.length;
    } catch (err) {
      console.error('[HELIUS WEBHOOK] upsert threw:', (err as Error).message);
      continue;
    }
  }

  // OBSERVABILITY: stamp ingest freshness for /api/status. Best-effort.
  if (written > 0) {
    try {
      await supabase.from('indexer_state').upsert(
        { key: 'last_webhook_at', value: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    } catch (err) {
      console.error('[HELIUS WEBHOOK] last_webhook_at stamp failed:', (err as Error).message);
    }
  }

  // REAL-TIME ALERTS: run AFTER the response so the 200 is never blocked.
  if (written > 0) {
    const touchedMints = [...new Set(rows.map((r) => r.token_mint))];
    try {
      // `after` schedules work post-response (Next.js). Fallback to inline
      // fire-and-forget if `after` is unavailable in the runtime.
      if (typeof after === 'function') {
        after(() => runBurstAlerts(touchedMints));
      } else {
        void runBurstAlerts(touchedMints);
      }
    } catch {
      void runBurstAlerts(touchedMints);
    }
  }

  return NextResponse.json({ ok: true, parsed, written });
}
