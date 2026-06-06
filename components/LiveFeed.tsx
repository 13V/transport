'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Radio } from 'lucide-react';
import * as f from '@/lib/format';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import {
  TokenMark, TradeLinks, AddrChip, TierBadge, EmptyState, ErrorState,
  SkTable, SkCard, CHART_COLORS,
} from '@/components/ui';

interface Burst {
  id: string;
  mint: string;
  symbol?: string | null;
  name?: string | null;
  icon?: string | null;
  icons?: string[] | null;
  buyers: number;
  buyerWallets: number;
  solTotal: number;
  windowStart: string;
  windowEnd: string;
  sampleBuyers: string[];
  tiers?: (string | null)[] | null;
  // Live market context (enriched server-side; optional so tsc stays clean
  // before the enrichment ships). Render only when present — no fake data.
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  priceChange24h?: number | null;
  priceUsd?: number | null;
  pairAddress?: string | null;
  finalized?: boolean;
}

interface LiveResponse {
  generatedAt: string;
  windowSec: number;
  minBuyers: number;
  count: number;
  nextCursor?: string | null;
  bursts: Burst[];
}

// Stable per-device owner id — the SAME identity the watchlist uses
// (localStorage key `sm_owner_id`, see lib/useWatchlist.ts). Reused as the
// push-subscription owner so a device's alerts and watchlist share one id.
const OWNER_KEY = 'sm_owner_id';

function getOwnerId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    let id = window.localStorage.getItem(OWNER_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `sm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(OWNER_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

// Public VAPID key for the browser PushManager (applicationServerKey). Set in
// Vercel as NEXT_PUBLIC_VAPID_PUBLIC_KEY (see WEBPUSH.md). Absent → the Alerts
// button hides itself.
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

// Convert a base64url VAPID key to the Uint8Array PushManager expects.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/**
 * Opt-in browser/desktop push alerts. Self-contained: registers /sw.js, requests
 * Notification permission, subscribes via PushManager using the public VAPID key,
 * and POSTs the subscription + owner id to /api/push/subscribe. Hides itself when
 * the browser lacks Push/Notification support or the VAPID key env is absent.
 */
function AlertsToggle() {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !VAPID_PUBLIC_KEY ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      return;
    }
    setSupported(true);
    // Reflect any existing subscription on mount.
    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const existing = reg ? await reg.pushManager.getSubscription() : null;
        setSubscribed(!!existing);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const subscribe = useCallback(async () => {
    if (!VAPID_PUBLIC_KEY) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setBusy(false);
        return;
      }
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), owner: getOwnerId() }),
      });
      setSubscribed(true);
    } catch {
      // Permission denied / unsupported / network — leave state as-is.
    } finally {
      setBusy(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        });
      }
      setSubscribed(false);
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }, []);

  if (!supported) return null;

  return (
    <button
      type="button"
      className={`seg-btn${subscribed ? ' on' : ''}`}
      onClick={subscribed ? unsubscribe : subscribe}
      disabled={busy}
      aria-pressed={subscribed}
      title={
        subscribed
          ? 'Burst alerts on — click to turn off browser notifications'
          : 'Get a browser/desktop notification when smart money bursts into a token'
      }
      style={{ whiteSpace: 'nowrap' }}
    >
      🔔 {subscribed ? 'Alerts on' : 'Alerts'}
    </button>
  );
}

const MIN_BUYERS: number[] = [3, 4, 5];
const WINDOW_SEC: number[] = [15, 30, 60];
const MIN_SOL: number[] = [0, 1, 5, 10];
const POLL_MS = 3 * 1000;

// Liquidity below this (USD) is a cheap rug proxy — flag it.
const LOW_LIQ_USD = 5_000;
// Realtime is only "fresh" if the last good fetch landed within this window.
const STALE_MS = 15_000;
// Hard floor between realtime-triggered refetches so a swap flood can't
// out-poll the poller.
const REALTIME_MIN_INTERVAL_MS = 3_000;

// Freshness-dot palette. CHART_COLORS lacks warn/neutral hues and lives in a
// file we don't own, so the amber/grey states are defined locally here.
const DOT_WARN = '#F2C879';    // amber — reconnecting / stale
const DOT_NEUTRAL = '#6A7184'; // grey  — before first successful fetch

// Compact USD: "$1.2M" / "$340k" / "$820". Returns null when absent so callers
// can render '—' / nothing rather than fake zeros.
function usdCompact(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `$${f.compact(n)}`;
}

// Parse an ISO timestamp into epoch ms (or null) for the ms-based formatters.
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function Header({
  minBuyers, onMinBuyers, windowSec, onWindowSec, minSol, onMinSol,
}: {
  minBuyers: number;
  onMinBuyers: (n: number) => void;
  windowSec: number;
  onWindowSec: (n: number) => void;
  minSol: number;
  onMinSol: (n: number) => void;
}) {
  return (
    <div className="page-head">
      <div className="sub">
        Bursts of smart-money buying — multiple verified wallets buying the same
        token within a short window, surfaced as the indexer ingests new trades.
      </div>
      <div className="page-head-actions row gap-10 wrap">
        <AlertsToggle />
        <div className="seg">
          {MIN_BUYERS.map((n) => (
            <button
              key={n}
              type="button"
              className={minBuyers === n ? 'on' : ''}
              onClick={() => onMinBuyers(n)}
              aria-pressed={minBuyers === n}
              title={`Only bursts with at least ${n} smart buyers`}
            >
              ≥{n}
            </button>
          ))}
        </div>
        <div className="seg">
          {WINDOW_SEC.map((w) => (
            <button
              key={w}
              type="button"
              className={windowSec === w ? 'on' : ''}
              onClick={() => onWindowSec(w)}
              aria-pressed={windowSec === w}
              title={`Max gap between buys in an accumulation streak: ${w}s`}
            >
              {w}s
            </button>
          ))}
        </div>
        <div className="seg">
          {MIN_SOL.map((s) => (
            <button
              key={s}
              type="button"
              className={minSol === s ? 'on' : ''}
              onClick={() => onMinSol(s)}
              aria-pressed={minSol === s}
              title={s === 0 ? 'Any size burst' : `Only bursts totalling at least ${s} SOL`}
            >
              {s === 0 ? 'Any' : `≥${s}◎`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function LiveFeed() {
  const router = useRouter();
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [minBuyers, setMinBuyers] = useState<number>(3);
  const [windowSec, setWindowSec] = useState<number>(30);
  const [minSol, setMinSol] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Wall-clock of the last SUCCESSFUL fetch — drives honest freshness/dot color.
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);

  // Track seen burst ids so we only highlight genuinely new cards on later polls.
  const seenRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);
  const mountedRef = useRef(true);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  // Re-rendered "now" tick so relative ages stay fresh between polls.
  const [, setTick] = useState(0);

  // Realtime: when connected, the browser is pushed every new trade INSERT and we
  // refetch instantly (no poll lag). null until we know; true once subscribed.
  const [realtimeOk, setRealtimeOk] = useState(false);
  // Current controls mirrored into refs so the realtime handler refetches with
  // the live filter values without re-subscribing on every control change.
  const ctrlRef = useRef({ min: minBuyers, win: windowSec, sol: minSol });
  ctrlRef.current = { min: minBuyers, win: windowSec, sol: minSol };
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp of the last realtime-triggered refetch, for the min-interval floor.
  const lastRealtimeFetchRef = useRef(0);

  const fetchLive = useCallback(async (min: number, win: number, sol: number) => {
    try {
      const res = await fetch(
        `/api/smart-money/live?windowSec=${win}&minBuyers=${min}&minSol=${sol}&hours=6&limit=50`
      );
      if (!res.ok) throw new Error('Failed to fetch live feed');
      const json = (await res.json()) as LiveResponse;
      if (!mountedRef.current) return;

      const next = json.bursts ?? [];

      // Diff against ids we've already shown. On the very first load every id is
      // "new", so we suppress the highlight and just seed the seen set.
      if (firstLoadRef.current) {
        firstLoadRef.current = false;
        setNewIds(new Set());
      } else {
        const fresh = new Set<string>();
        for (const b of next) {
          if (!seenRef.current.has(b.id)) fresh.add(b.id);
        }
        setNewIds(fresh);
      }
      for (const b of next) seenRef.current.add(b.id);

      setBursts(next);
      setGeneratedAt(json.generatedAt ?? new Date().toISOString());
      setLastOkAt(Date.now());
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load live feed');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Initial fetch + refetch whenever the controls change. Reset the highlight
  // baseline so a control change doesn't flag everything as "new".
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    firstLoadRef.current = true;
    seenRef.current = new Set();
    fetchLive(minBuyers, windowSec, minSol);
    return () => { mountedRef.current = false; };
  }, [fetchLive, minBuyers, windowSec, minSol]);

  // Realtime push: subscribe once to trade INSERTs. Each insert (debounced ~700ms
  // to coalesce bursts of swaps) triggers an instant refetch with the CURRENT
  // controls. Falls back silently to polling if Supabase Realtime isn't configured.
  useEffect(() => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const channel = sb
      .channel('live-trades')
      .on(
        'postgres_changes',
        // Bursts only consider buys — filter server-side to halve message volume.
        { event: 'INSERT', schema: 'public', table: 'trades', filter: 'trade_type=eq.BUY' },
        () => {
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            // Hard min-interval floor: ignore realtime triggers that arrive
            // within REALTIME_MIN_INTERVAL_MS of the last one so a swap flood
            // can't out-poll the safety poller.
            const now = Date.now();
            if (now - lastRealtimeFetchRef.current < REALTIME_MIN_INTERVAL_MS) return;
            lastRealtimeFetchRef.current = now;
            fetchLive(ctrlRef.current.min, ctrlRef.current.win, ctrlRef.current.sol);
          }, 700);
        }
      )
      .subscribe((status) => {
        if (mountedRef.current) setRealtimeOk(status === 'SUBSCRIBED');
      });
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      sb.removeChannel(channel);
    };
  }, [fetchLive]);

  // Poll for the current controls. When Realtime is pushing, this drops to a slow
  // safety net (catches missed events / dropped sockets); otherwise it's the
  // primary 3s refresh.
  useEffect(() => {
    const pollMs = realtimeOk ? 30_000 : POLL_MS;
    const interval = setInterval(() => fetchLive(minBuyers, windowSec, minSol), pollMs);
    return () => clearInterval(interval);
  }, [fetchLive, minBuyers, windowSec, minSol, realtimeOk]);

  // Keep relative ages ticking between polls (every 5s is plenty).
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return (
      <div className="view stack gap-24">
        <Header
          minBuyers={minBuyers} onMinBuyers={setMinBuyers}
          windowSec={windowSec} onWindowSec={setWindowSec}
          minSol={minSol} onMinSol={setMinSol}
        />
        <div className="stack gap-12">
          <SkCard h={60} />
          <SkTable cols={4} rows={6} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="view stack gap-24">
        <Header
          minBuyers={minBuyers} onMinBuyers={setMinBuyers}
          windowSec={windowSec} onWindowSec={setWindowSec}
          minSol={minSol} onMinSol={setMinSol}
        />
        <div className="card">
          <ErrorState
            msg="The live feed didn’t respond."
            onRetry={() => { setLoading(true); fetchLive(minBuyers, windowSec, minSol); }}
          />
        </div>
      </div>
    );
  }

  // HONEST FRESHNESS — color the live dot by actual state instead of a
  // hardcoded green. Green only when realtime is connected AND the last good
  // fetch is recent; amber when realtime dropped (polling fallback) or the
  // last fetch went stale; grey before the first successful fetch.
  const sinceOk = lastOkAt == null ? Infinity : Date.now() - lastOkAt;
  const stale = sinceOk > STALE_MS;
  const freshness =
    lastOkAt == null
      ? { color: DOT_NEUTRAL, label: 'connecting…' }
      : realtimeOk && !stale
      ? { color: CHART_COLORS.POS, label: 'live — updates instantly' }
      : !realtimeOk
      ? { color: DOT_WARN, label: 'reconnecting… — polling every 3s' }
      : { color: DOT_WARN, label: 'stale — retrying…' };

  return (
    <div className="view stack gap-16">
      <Header
        minBuyers={minBuyers} onMinBuyers={setMinBuyers}
        windowSec={windowSec} onWindowSec={setWindowSec}
        minSol={minSol} onMinSol={setMinSol}
      />

      <div className="card card-pad">
        <div className="row gap-10" style={{ alignItems: 'center' }}>
          <span
            aria-hidden
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: freshness.color,
              boxShadow: `0 0 0 3px ${freshness.color}33`,
              flexShrink: 0,
            }}
          />
          <span className="faint" style={{ fontSize: 12 }}>
            Updated {f.ago(lastOkAt)} · {freshness.label}
          </span>
        </div>
      </div>

      {bursts.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Radio}
            title="No bursts yet"
            msg={`Bursts appear when ≥${minBuyers} smart wallets pile into the same token within ${windowSec}s.`}
          />
        </div>
      ) : (
        <div className="bf-list stack gap-8">
          {bursts.map((b) => {
            const symbol = b.symbol || f.short(b.mint, 4, 4);
            const startMs = ms(b.windowStart);
            const endMs = ms(b.windowEnd);
            const spanSec =
              startMs != null && endMs != null
                ? Math.max(0, Math.round((endMs - startMs) / 1000))
                : null;
            // Burst duration as a tidy "over Xm"/"over Xs" string.
            const durLabel =
              spanSec == null
                ? null
                : spanSec >= 60
                ? `over ${Math.round(spanSec / 60)}m`
                : `over ${spanSec}s`;
            const isNew = newIds.has(b.id);
            const sample = b.sampleBuyers.slice(0, 4);
            const tiers = b.tiers ?? [];

            // Compact conviction summary from the present tiers, e.g. "S·A·B".
            const tierSummary = tiers.filter((t): t is string => !!t).join('·');

            // TRAP heuristic: many wallets attributed to few entities → likely
            // one actor faking a crowd. Promote to a visible warning chip.
            const isTrap = b.buyerWallets >= 2 * b.buyers && b.buyers > 0;

            // Low-liquidity rug proxy (only when liquidity is actually present).
            const lowLiq = b.liquidityUsd != null && b.liquidityUsd < LOW_LIQ_USD;

            const mcap = usdCompact(b.marketCapUsd);
            const liq = usdCompact(b.liquidityUsd);
            const chg = b.priceChange24h;
            // A burst is still accumulating until it's been finalized.
            const isLive = b.finalized === false;
            return (
              <div
                key={b.id}
                className={`bf-row${isNew ? ' is-new' : ''}`}
                onClick={() => router.push(`/token/${b.mint}`)}
              >
                {/* LEFT: identity → hero SOL → accumulating cue → metrics → buyers */}
                <div className="stack gap-10" style={{ minWidth: 0 }}>
                  <div className="bf-id">
                    <TokenMark
                      symbol={b.symbol || b.mint}
                      icon={b.icon ?? undefined}
                      icons={b.icons ?? undefined}
                      size={34}
                    />
                    <div className="bf-id-text">
                      <div className="bf-ticker-line">
                        <span className="bf-ticker">{symbol}</span>
                        {b.name && <span className="bf-name">{b.name}</span>}
                      </div>
                      <div className="bf-meta-line">
                        <span className="bf-mint mono">{f.short(b.mint, 4, 4)}</span>
                        <span className="bf-age">· {f.ago(endMs)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Hero: cumulative SOL is the headline now that bursts accumulate */}
                  <div className="bf-hero">
                    <span className="bf-sol">
                      {f.sol(b.solTotal)}<span className="unit">SOL</span>
                    </span>
                    <span className="bf-wallets">
                      <b>{b.buyers}</b> smart {b.buyers === 1 ? 'wallet' : 'wallets'}
                    </span>
                    {tierSummary && (
                      <span
                        className="bf-tiermix"
                        title="Tiers of the sampled buyers (conviction at a glance)"
                      >
                        {tierSummary}
                      </span>
                    )}
                  </div>

                  {(isLive || (b.buyerWallets > b.buyers && !isTrap)) && (
                    <div className="bf-sub">
                      {isLive && (
                        <span className="bf-accum" title="This burst is still growing as new buys land">
                          ▲ accumulating
                        </span>
                      )}
                      {b.buyerWallets > b.buyers && !isTrap && (
                        <span>{b.buyerWallets} wallets / {b.buyers} entities</span>
                      )}
                    </div>
                  )}

                  {/* Compact metric strip — render only fields that are present */}
                  {(mcap || liq || (chg != null && Number.isFinite(chg)) || durLabel || isTrap || lowLiq) && (
                    <div className="bf-metrics">
                      {mcap && (
                        <div className="bf-metric">
                          <span className="k">MC</span>
                          <span className="v">{mcap}</span>
                        </div>
                      )}
                      {liq && (
                        <div className="bf-metric">
                          <span className="k">Liq</span>
                          <span className="v">{liq}</span>
                        </div>
                      )}
                      {chg != null && Number.isFinite(chg) && (
                        <div className="bf-metric">
                          <span className="k">24h</span>
                          <span className={`v ${chg >= 0 ? 'pos' : 'neg'}`}>{f.pct(chg)}</span>
                        </div>
                      )}
                      {durLabel && (
                        <div className="bf-metric">
                          <span className="k">Span</span>
                          <span className="v dim">{durLabel}</span>
                        </div>
                      )}
                      {isTrap && (
                        <span
                          className="bf-trap"
                          style={{ alignSelf: 'center' }}
                          title="Many wallets map to few entities — likely one actor faking a crowd"
                        >
                          TRAP · {b.buyerWallets}w / {b.buyers}e
                        </span>
                      )}
                      {lowLiq && (
                        <span
                          className="bf-trap"
                          style={{ alignSelf: 'center' }}
                          title={`Liquidity under $${LOW_LIQ_USD / 1000}k — high rug risk`}
                        >
                          LOW LIQ
                        </span>
                      )}
                    </div>
                  )}

                  {sample.length > 0 && (
                    <div className="bf-buyers">
                      {sample.map((addr, i) => (
                        <span key={addr} className="bf-buyer">
                          <AddrChip address={addr} />
                          {tiers[i] && <TierBadge tier={tiers[i]} />}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* RIGHT: live/ended status on top, prominent Ape + subdued links below */}
                <div className="bf-right">
                  {isLive ? (
                    <span className="bf-status live" title="This burst is still being added to">
                      <span className="dot" aria-hidden /> Live
                    </span>
                  ) : (
                    <span className="bf-status ended" title={`Burst ended ${f.ago(endMs)}`}>
                      ended
                    </span>
                  )}
                  <div className="bf-actions">
                    <TradeLinks mint={b.mint} size="xs" primary />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        @keyframes lf-fade-in {
          from { opacity: 0.35; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
