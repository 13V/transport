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
import { timingSafeEqual } from 'crypto';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { parseHeliusSwaps } from '../../../../lib/helius/parse-swap';
import {
  getSmartWalletSet,
  detectBurstsForMintsBothSides,
  type LiveBurst,
} from '../../../../lib/indexer/live-bursts';
import { readCooldowns, writeCooldowns } from '../../../../lib/alerts/cooldowns';
import { sendAlert, escapeHtml } from '../../../../lib/alerts/notifier';
import { sendWebPushToAll, sendWebPushToOwner } from '../../../../lib/push';
import { tokenLinks } from '../../../../lib/trade-links';
import { evaluateWatchRules, type EvalRule } from '../../../../lib/watch-eval';

export const dynamic = 'force-dynamic';
// The route ACKs 200 immediately and does ALL persistence in after(); if that
// background work exceeds maxDuration it is killed and Helius will NOT retry
// (it already got the 200) — trades would be silently lost. 60s (the Vercel
// Hobby ceiling) gives the upsert + alert fan-out the full budget.
export const maxDuration = 60;

const CHUNK = 500;

// Real-time burst-alert cooldown blob (mint -> last-alert epoch-ms).
const BURST_COOLDOWN_KEY = 'alert_cooldowns_burst';
// Separate cooldown blob for sell/exit bursts so they never share suppression
// with buy bursts (a token can fire a buy burst and later an exit burst).
const SELL_BURST_COOLDOWN_KEY = 'alert_cooldowns_sell_burst';
// Per-user watchlist push de-dup, keyed `${owner}:${mint}` -> last-push ms.
const WATCH_COOLDOWN_KEY = 'alert_cooldowns_watch';
// Custom watch-rule push de-dup, keyed `${owner}:${mint}:${ruleId}` -> last ms.
const RULE_COOLDOWN_KEY = 'alert_cooldowns_rule';

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
    // Burst window (env-configurable; smart money trickles in over minutes, so a
    // 30s window essentially never fired). Shared by the detect call and labels.
    const windowSec = envInt('BURST_WINDOW_SEC', 180);
    const cooldownMin = envInt('ALERT_BURST_COOLDOWN_MIN', 30);
    const cooldownMs = cooldownMin * 60_000;
    const now = Date.now();

    // COALESCED SCAN: detect BUY and SELL bursts from ONE trades query (instead
    // of two passes), then handle each side below. The sell side honors its own
    // env-gated entity threshold so the detected results match the old two-call
    // behavior exactly.
    const sellEnabled = process.env.ALERT_SELL_BURSTS !== '0';
    const minSellEntities = envInt('ALERT_SELL_MIN_ENTITIES', 3);
    const { buy: bursts, sell: sellBursts } = await detectBurstsForMintsBothSides(
      mints,
      {
        windowSec,
        minBuyBuyers: minBuyers,
        // Detect at the sell gate's entity threshold; if sell alerts are
        // disabled we still pass a sane default but skip the path entirely below.
        minSellEntities,
      }
    );

    // PER-USER WATCHLIST PUSH — fires for ANY detected buy burst (even below the
    // broadcast bar), since each such user explicitly opted into that wallet.
    // Runs off the SAME detected bursts; one watchlists query per batch.
    await runWatchlistPush(bursts, now);

    // CUSTOM WATCH-RULE PUSH — evaluate each owner's user-defined alert rules
    // (watch_rules) against the SAME detected bursts and push any matches. Uses
    // its own cooldown blob + the web-push sender only. Wrapped + no-throw.
    await runWatchRules(bursts, now);

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
        `bought ${fmtSol(b.solTotal)} SOL within ${windowSec}s` +
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
          body: `${b.buyers} smart wallets bought ${fmtSol(b.solTotal)} SOL in ${windowSec}s`,
          url: `/token/${mint}`,
        });
      } catch (error) {
        console.error('[HELIUS WEBHOOK] web push send failed for', mint, (error as Error).message);
      }
    }

    if (stamped) await writeCooldowns(BURST_COOLDOWN_KEY, cooldowns);

    // EXIT / SELL-BURST ALERTS — distinct broadcast, separate cooldown blob.
    // Reuses the sell bursts already detected by the coalesced scan above.
    if (sellEnabled) await runSellBurstAlerts(sellBursts, now);
  } catch (error) {
    // Alerting must NEVER affect ingestion.
    console.error('[HELIUS WEBHOOK] burst alert step failed:', (error as Error).message);
  }
}

/**
 * EXIT / SELL-BURST broadcast: given the already-detected SELL bursts (≥N
 * distinct smart-money ENTITIES SELLING the same token within the window) from
 * the coalesced scan, when the gate passes (min entities + min SOL) broadcasts a
 * distinct "smart money EXITING" alert via Telegram + web push. Uses a SEPARATE
 * per-mint cooldown blob so it never collides with buy bursts. Env-gated by the
 * caller; mirrors the buy path's stamp-on-delivery + try/catch isolation.
 * Wrapped so any failure is swallowed.
 */
async function runSellBurstAlerts(bursts: LiveBurst[], now: number): Promise<void> {
  try {
    const minEntities = envInt('ALERT_SELL_MIN_ENTITIES', 3);
    const minSol = envNum('ALERT_SELL_MIN_SOL', 5);
    // Same env-configurable window as the buy path (the bursts were detected at
    // this window by the coalesced scan) so the labels stay accurate.
    const windowSec = envInt('BURST_WINDOW_SEC', 180);
    const cooldownMin = envInt('ALERT_SELL_COOLDOWN_MIN', 30);
    const cooldownMs = cooldownMin * 60_000;

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
        `sold ${fmtSol(b.solTotal)} SOL in ${windowSec}s` +
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
          body: `${b.buyers} entities sold ${fmtSol(b.solTotal)} SOL in ${windowSec}s`,
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
 * CUSTOM WATCH-RULE PUSH: evaluate each owner's user-defined alert rules
 * (watch_rules) against the detected BUY bursts via lib/watch-eval, then push
 * the matches through the EXISTING web-push sender (owner-scoped). One
 * watch_rules query per webhook batch (only rules for owners whose wallets — or
 * whose "any wallet" rules — could match are worth loading, but a single scan of
 * all rules is cheap and simplest; we filter in-memory). holdingOnly rules use
 * the owner's watchlist as the holding set. De-duped per (owner, mint, ruleId)
 * via a dedicated cooldown blob, separate from the broadcast + watchlist blobs.
 * Wrapped so any failure is swallowed — alerting must never affect ingestion.
 */
async function runWatchRules(bursts: LiveBurst[], now: number): Promise<void> {
  try {
    if (bursts.length === 0 || !isSupabaseConfigured()) return;

    const supabase = getSupabase();

    // PREFILTER the read so the hot ingest path never full-scans watch_rules.
    // Rules fall into two classes:
    //   - wallet-scoped  → their `wallets` text[] intersects THIS batch's buyer
    //                       wallets (Postgres array-overlap, `.overlaps`)
    //   - any-wallet      → empty/null `wallets` (always candidates)
    // We fetch only those two sets (any-wallet + overlapping) instead of the
    // whole table, then evaluate in lib/watch-eval as before. A hard `.limit`
    // caps the result as a safety ceiling regardless of prefilter selectivity.
    const RULE_READ_LIMIT = 2000;
    const batchWallets = Array.from(
      new Set(bursts.flatMap((b) => b.wallets ?? []).filter((w) => typeof w === 'string' && w))
    );

    // PostgREST array literal for the `.overlaps` operand, e.g. {w1,w2}. Wallet
    // addresses are base58 (no commas/braces), so no escaping is needed.
    let query = supabase
      .from('watch_rules')
      .select('id, owner, label, wallets, min_buyers, min_sol, holding_only, channels, muted');
    // Defense-in-depth: these strings derive from the (secret-gated) webhook
    // payload and are string-joined into a PostgREST filter expression — keep
    // only well-formed base58 addresses so nothing can mangle the filter.
    const safeWallets = batchWallets.filter((w) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w));
    if (safeWallets.length > 0) {
      // any-wallet rules (empty array OR null) OR rules overlapping the batch.
      query = query.or(
        `wallets.ov.{${safeWallets.join(',')}},wallets.eq.{},wallets.is.null`
      );
    } else {
      // No wallets in this batch → only any-wallet rules can match.
      query = query.or('wallets.eq.{},wallets.is.null');
    }
    const { data: ruleRows, error: ruleErr } = await query.limit(RULE_READ_LIMIT);
    if (ruleErr || !ruleRows || ruleRows.length === 0) return;

    const rules: EvalRule[] = (ruleRows as Record<string, unknown>[]).map((r) => ({
      id: typeof r.id === 'string' ? r.id : null,
      owner: typeof r.owner === 'string' ? r.owner : '',
      label: typeof r.label === 'string' && r.label ? r.label : null,
      wallets: Array.isArray(r.wallets) ? (r.wallets as unknown[]).filter((w): w is string => typeof w === 'string') : [],
      minBuyers: Number.isFinite(Number(r.min_buyers)) ? Number(r.min_buyers) : 3,
      minSol: Number.isFinite(Number(r.min_sol)) ? Number(r.min_sol) : 0,
      holdingOnly: Boolean(r.holding_only),
      channels: Array.isArray(r.channels)
        ? (r.channels as unknown[]).filter((c): c is string => typeof c === 'string')
        : ['push'],
      muted: Boolean(r.muted),
    })).filter((r) => r.owner);
    if (rules.length === 0) return;

    // holdingOnly support: build owner -> watched-wallet set, but only for owners
    // that actually have a holdingOnly rule (avoids loading watchlists we won't
    // use). Best-effort; missing watchlists make holdingOnly fail-open (see
    // lib/watch-eval).
    let holdings: Map<string, Set<string>> | undefined;
    const holdingOwners = Array.from(
      new Set(rules.filter((r) => r.holdingOnly).map((r) => r.owner))
    );
    if (holdingOwners.length > 0) {
      try {
        const { data: wlRows } = await supabase
          .from('watchlists')
          .select('owner_id, address')
          .in('owner_id', holdingOwners);
        holdings = new Map();
        for (const r of (wlRows ?? []) as { owner_id: string; address: string }[]) {
          if (!r.owner_id || !r.address) continue;
          let set = holdings.get(r.owner_id);
          if (!set) {
            set = new Set();
            holdings.set(r.owner_id, set);
          }
          set.add(r.address);
        }
      } catch {
        // watchlists missing → holdingOnly rules fail-open in watch-eval.
        holdings = undefined;
      }
    }

    // Pure evaluation → list of (owner, mint, rule) push notifications.
    const evalBursts = bursts.map((b) => ({
      mint: b.mint,
      symbol: b.symbol,
      buyers: b.buyers,
      solTotal: b.solTotal,
      wallets: b.wallets ?? [],
    }));
    const notifications = evaluateWatchRules(evalBursts, rules, holdings);
    if (notifications.length === 0) return;

    const cooldownMs = envInt('ALERT_RULE_COOLDOWN_MIN', 30) * 60_000;
    const cooldowns = await readCooldowns(RULE_COOLDOWN_KEY);
    let stamped = false;

    for (const n of notifications) {
      const ckey = `${n.owner}:${n.mint}:${n.ruleId ?? 'anon'}`;
      const last = cooldowns[ckey];
      if (typeof last === 'number' && now - last < cooldownMs) continue;
      // Stamp first so a retry/duplicate in the same batch can't double-send.
      cooldowns[ckey] = now;
      stamped = true;

      const symbol = n.symbol ? `$${n.symbol}` : `${n.mint.slice(0, 6)}…`;
      const label = n.ruleLabel ? `${n.ruleLabel}: ` : '';
      try {
        await sendWebPushToOwner(n.owner, {
          title: `🔔 ${label}${symbol}`,
          body:
            `${n.buyers} smart wallet${n.buyers === 1 ? '' : 's'} bought ` +
            `${fmtSol(n.solTotal)} SOL` +
            (n.matchedWallet ? ` (incl. ${shortWallet(n.matchedWallet)})` : ''),
          url: `/token/${n.mint}`,
        });
      } catch (error) {
        console.error('[HELIUS WEBHOOK] watch-rule push failed for', n.owner, (error as Error).message);
      }
    }

    if (stamped) await writeCooldowns(RULE_COOLDOWN_KEY, cooldowns);
  } catch (error) {
    console.error('[HELIUS WEBHOOK] watch-rule step failed:', (error as Error).message);
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

/**
 * Background ingestion + alerting, run via `after()` so the 200 ACKs first.
 * Resolves the smart-wallet set HERE (off the ack path) for correct attribution,
 * parses the swaps, idempotently upserts trades, stamps freshness, then fires the
 * real-time alerts. Self-contained + no-throw: a slow/cold smart-set resolve can
 * never delay the webhook ACK (Helius retries slow/failed acks), and writes stay
 * idempotent via the unique-constraint upsert. `payload` was already read on the
 * request path (the body stream isn't available after the response is sent).
 */
async function ingestAndAlert(payload: unknown): Promise<void> {
  try {
    // Attribute to OUR wallets only: resolve the subscribed smart-wallet set
    // (memoized) and pass it so the parser doesn't trust a relayer/counterparty
    // feePayer. Resolved HERE (background) rather than before the ACK so a cold
    // instance's heavy paginate+cluster resolve never blocks the 200. Degrades to
    // undefined (feePayer trust) only if resolution is empty, preserving prior
    // behavior rather than dropping every trade.
    const wallets = await getSubscribedWallets();
    const rows = parseHeliusSwaps(payload, wallets.size > 0 ? wallets : undefined);
    if (rows.length === 0 || !isSupabaseConfigured()) return;

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
          continue; // keep other chunks
        }
        written += chunk.length;
      } catch (err) {
        console.error('[HELIUS WEBHOOK] upsert threw:', (err as Error).message);
        continue;
      }
    }

    if (written === 0) return;

    // OBSERVABILITY: stamp ingest freshness for /api/status. Best-effort.
    try {
      await supabase.from('indexer_state').upsert(
        { key: 'last_webhook_at', value: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    } catch (err) {
      console.error('[HELIUS WEBHOOK] last_webhook_at stamp failed:', (err as Error).message);
    }

    // REAL-TIME ALERTS (off the ack path; smart set already resolved above).
    const touchedMints = [...new Set(rows.map((r) => r.token_mint))];
    await runBurstAlerts(touchedMints);
  } catch (error) {
    // Background work must NEVER surface; the ACK already went out.
    console.error('[HELIUS WEBHOOK] background ingest failed:', (error as Error).message);
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
  // Constant-time, length-guarded compare (matches the cron-route pattern). The
  // header must equal the secret verbatim (Helius sends authHeader as-is).
  const auth = request.headers.get('authorization') ?? '';
  const a = Buffer.from(auth);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ---- Parse body (expected: array of enriched txs). Read on the request path
  // because the body stream is no longer available inside `after()`. ----
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    // Malformed JSON: 200 no-op so Helius doesn't hammer retries.
    return NextResponse.json({ ok: true });
  }

  // ACK IMMEDIATELY. All heavy work — the smart-set resolve (a cold instance's
  // paginate+cluster), parse, idempotent upserts, and alerts — runs in the
  // background via `after()` so Helius gets a fast 200 and never retries on a
  // slow ack. Writes stay idempotent, so async processing is safe; auth above
  // already fail-closed gated this request.
  try {
    if (typeof after === 'function') {
      after(() => ingestAndAlert(payload));
    } else {
      void ingestAndAlert(payload);
    }
  } catch {
    void ingestAndAlert(payload);
  }

  return NextResponse.json({ ok: true });
}
