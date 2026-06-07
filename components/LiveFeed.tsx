'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Radio, Star } from 'lucide-react';
import * as f from '@/lib/format';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { useWatchlist } from '@/lib/useWatchlist';
import {
  TokenMark, TradeLinks, AddrChip, TierBadge, EmptyState, ErrorState,
  SkTable, SkCard, CHART_COLORS, Sparkline,
} from '@/components/ui';
import { tokenLinks } from '@/lib/trade-links';

interface BuyerStat {
  addr: string;
  tier?: string | null;
  roiPct?: number | null;
  winRate?: number | null;
}

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
  // Wave 2 enrichment — all optional; render only when present, never fabricate.
  buyerStats?: BuyerStat[] | null;       // aligned to sampleBuyers
  leadBuyer?: string | null;             // wallet that fired first
  leadTier?: string | null;
  smartSetSize?: number | null;          // total known smart wallets (coverage)
  suggestedSizeSol?: number | null;
  mintRenounced?: boolean | null;
  freezeRenounced?: boolean | null;
  pairCreatedAt?: string | null;
  buys24h?: number | null;
  sells24h?: number | null;
  volume24hUsd?: number | null;
  topHolderPct?: number | null;
}

interface LiveResponse {
  generatedAt: string;
  windowSec: number;
  minBuyers: number;
  count: number;
  nextCursor?: string | null;
  bursts: Burst[];
}

// Measured-outcomes proof header payload (GET /api/smart-money/live/stats).
interface LiveStats {
  n: number;
  burstsToday?: number | null;
  medianRet1h?: number | null;
  hitRate1h?: number | null;
  medianRet24h?: number | null;
  hitRate24h?: number | null;
  bestCall?: { symbol?: string | null; mint?: string | null; ret?: number | null } | null;
  windowHours?: number | null;
}

// --- Wave 3: inline price sparkline series (from /api/token/ohlcv/batch) ---
interface OhlcvSeries {
  closes: number[];
  times: number[];
  last: number | null;
}
interface OhlcvBatchResponse {
  tf: string;
  results: Record<string, OhlcvSeries>;
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

// --- SSE (near-instant burst stream) ---
// The browser EventSource auto-reconnects on its own using the server's `retry`
// hint, so we don't manage reconnection backoff ourselves. We DO run a connect
// watchdog: if no `snapshot` arrives within this window after (re)opening, we
// treat the stream as unhealthy and fall back to polling until it recovers.
const SSE_WATCHDOG_MS = 8_000;

// Liquidity below this (USD) is a cheap rug proxy — flag it (flat fallback).
const LOW_LIQ_USD = 5_000;
// liq/MC ratio below this → "THIN LIQ" (supersedes the flat guard when MC known).
const THIN_LIQ_RATIO = 0.02;
// Token age under this (ms) tints the age chip red — very new = higher rug risk.
const VERY_NEW_MS = 10 * 60 * 1000;
// Top-holder concentration above this → whale-risk amber chip.
const WHALE_PCT = 25;
// Realtime is only "fresh" if the last good fetch landed within this window.
const STALE_MS = 15_000;
// Hard floor between realtime-triggered refetches so a swap flood can't
// out-poll the poller.
const REALTIME_MIN_INTERVAL_MS = 3_000;
// Proof-header stats refresh cadence.
const STATS_REFRESH_MS = 5 * 60 * 1000;

// --- Wave 3 ---
// Cap on how many distinct mints we ask the OHLCV batch for in one go (matches
// the endpoint's MAX_MINTS). Keeps a single fetch cheap.
const OHLCV_MAX_MINTS = 50;
// How long a fetched price series is considered fresh in the client cache. The
// endpoint itself caches ~60s; this stops re-polls (every 3s) from refetching
// a mint we already have a recent series for, so OHLCV never rides the poll tick.
const OHLCV_TTL_MS = 60_000;
// Hottest-tokens strip size.
const HOT_STRIP_SIZE = 6;

// --- Axiom-style entry animation tuning ---
// Cap how many freshly-arrived bursts animate in one tick — a big snapshot must
// not animate 50 rows. Extra new ids still surface at the top, they just skip
// the per-row entry transition.
const ENTER_MAX_ANIMATED = 6;
// Delay between staggered entries so a batch cascades intentionally (ms/row).
const ENTER_STAGGER_MS = 70;
// How long an id stays "entering" (drives top-placement + glow) before it folds
// back into the normal sorted list. Covers the expand (~400ms) + glow (~1.2s).
const ENTER_HOLD_MS = 1400;

// localStorage key for the "group bursts by token" toggle (Wave 3, default ON).
const PREF_GROUP_KEY = 'sm_pref_group_by_token';

// localStorage keys for the per-user execution prefs (default terminal + size).
// Keyed off the same owner id the watchlist uses so prefs ride with the device.
const PREF_TERMINAL_KEY = 'sm_pref_terminal';
const PREF_SIZE_KEY = 'sm_pref_size_sol';
// Terminals the user may promote (must match labels in lib/trade-links.ts).
const TERMINALS = ['Axiom', 'GMGN', 'BullX', 'Photon', 'Jupiter'] as const;

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

// Short relative age like "2m"/"45s"/"3h" from a created-at timestamp.
function ageShort(fromMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Mcap tier label for a USD market cap. null when unknown.
function mcapTier(mc: number | null | undefined): string | null {
  if (mc == null || !Number.isFinite(mc)) return null;
  if (mc < 100_000) return 'micro';
  if (mc < 1_000_000) return 'small';
  return 'mid';
}

// --- Wave 3 helpers ---

// Burst buying velocity in SOL/min over its window (null when undeterminable).
function burstVelSolMin(b: Burst): number | null {
  const start = ms(b.windowStart);
  const end = ms(b.windowEnd);
  if (start == null || end == null) return null;
  const span = Math.max(0, (end - start) / 1000);
  if (span <= 0) return null;
  return (b.solTotal / span) * 60;
}

// Hotness score for the strip: blends crowd size, velocity, SOL committed and a
// freshness decay. Derived ONLY from already-loaded burst fields — no new fetch.
function hotness(b: Burst, now: number): number {
  const buyers = Number.isFinite(b.buyers) ? b.buyers : 0;
  const sol = Number.isFinite(b.solTotal) ? b.solTotal : 0;
  const vel = burstVelSolMin(b) ?? 0;
  const end = ms(b.windowEnd);
  // Recency multiplier: 1.0 fresh → ~0.3 after ~30m, gentle decay.
  const ageMin = end != null ? Math.max(0, (now - end) / 60000) : 60;
  const recency = 1 / (1 + ageMin / 12);
  // Still-accumulating bursts are hotter.
  const liveBoost = b.finalized === false ? 1.25 : 1;
  const raw = buyers * 3 + sol * 1.2 + vel * 2;
  return raw * recency * liveBoost;
}

// Pick the freshest/most-significant burst for a token: prefer non-finalized,
// else the latest windowEnd.
function pickPrimary(a: Burst, b: Burst): Burst {
  const aLive = a.finalized === false;
  const bLive = b.finalized === false;
  if (aLive !== bLive) return aLive ? a : b;
  return (ms(b.windowEnd) ?? 0) > (ms(a.windowEnd) ?? 0) ? b : a;
}

// Does this device ask for reduced motion? Read live (not cached) so a system
// preference change is respected on the next render path that calls it.
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// Read the "group by token" pref (default ON when unset).
function readGroupPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const v = window.localStorage.getItem(PREF_GROUP_KEY);
    return v == null ? true : v === '1';
  } catch {
    return true;
  }
}

// Read execution prefs from localStorage (terminal + default size).
function readPrefs(): { terminal: string | null; size: number | null } {
  if (typeof window === 'undefined') return { terminal: null, size: null };
  try {
    const terminal = window.localStorage.getItem(PREF_TERMINAL_KEY);
    const rawSize = window.localStorage.getItem(PREF_SIZE_KEY);
    const size = rawSize != null && rawSize !== '' ? Number(rawSize) : null;
    return {
      terminal: terminal && TERMINALS.includes(terminal as (typeof TERMINALS)[number]) ? terminal : null,
      size: size != null && Number.isFinite(size) && size > 0 ? size : null,
    };
  } catch {
    return { terminal: null, size: null };
  }
}

/** One-tap WATCH star for a token mint. Reuses the watchlist hook/store. */
function BurstWatchStar({ mint }: { mint: string }) {
  const { isWatched, toggle } = useWatchlist();
  const on = isWatched(mint);
  return (
    <button
      type="button"
      className={`iconbtn star ${on ? 'on' : ''}`}
      title={on ? 'Remove token from watchlist' : 'Watch this token'}
      aria-label={on ? 'Remove token from watchlist' : 'Watch this token'}
      aria-pressed={on}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(mint); }}
    >
      <Star size={14} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

/** Share-to-X (Twitter) intent button for a burst. */
function ShareButton({ burst, symbol }: { burst: Burst; symbol: string }) {
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const tiers = (burst.tiers ?? []).filter((t): t is string => !!t).join('·');
    const parts = [
      `${burst.buyers} smart wallets aping $${symbol}`,
      `${f.sol(burst.solTotal)} SOL`,
    ];
    if (tiers) parts.push(`tiers ${tiers}`);
    const text = `🔥 ${parts.join(' · ')}`;
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const url = `${origin}/token/${burst.mint}`;
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    if (typeof window !== 'undefined') window.open(intent, '_blank', 'noopener,noreferrer');
  };
  return (
    <button
      type="button"
      className="iconbtn"
      title="Share this burst on X"
      aria-label="Share on X"
      onClick={onClick}
    >
      𝕏
    </button>
  );
}

function Header({
  minBuyers, onMinBuyers, windowSec, onWindowSec, minSol, onMinSol,
  sort, onSort, status, onStatus, compact, onCompact,
  groupByToken, onGroupByToken,
  prefTerminal, prefSize, onSavePrefs,
}: {
  minBuyers: number;
  onMinBuyers: (n: number) => void;
  windowSec: number;
  onWindowSec: (n: number) => void;
  minSol: number;
  onMinSol: (n: number) => void;
  sort: 'quality' | 'recent';
  onSort: (s: 'quality' | 'recent') => void;
  status: 'all' | 'live' | 'cooling';
  onStatus: (s: 'all' | 'live' | 'cooling') => void;
  compact: boolean;
  onCompact: (b: boolean) => void;
  groupByToken: boolean;
  onGroupByToken: (b: boolean) => void;
  prefTerminal: string | null;
  prefSize: number | null;
  onSavePrefs: (terminal: string | null, size: number | null) => void;
}) {
  return (
    <div className="page-head">
      <div className="sub">
        Bursts of smart-money buying — multiple verified wallets buying the same
        token within a short window, surfaced as the indexer ingests new trades.
      </div>
      <div className="page-head-actions row gap-10 wrap">
        <AlertsToggle />
        <div className="seg" title="Minimum smart buyers per burst">
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

        {/* SORT */}
        <div className="seg" title="Order bursts by signal quality or recency">
          <button
            type="button"
            className={sort === 'quality' ? 'on' : ''}
            onClick={() => onSort('quality')}
            aria-pressed={sort === 'quality'}
            title="Best signal first"
          >
            Quality
          </button>
          <button
            type="button"
            className={sort === 'recent' ? 'on' : ''}
            onClick={() => onSort('recent')}
            aria-pressed={sort === 'recent'}
            title="Newest first"
          >
            Recent
          </button>
        </div>

        {/* STATUS filter (client-side, uses finalized) */}
        <div className="seg" title="Filter by burst lifecycle">
          <button
            type="button"
            className={status === 'all' ? 'on' : ''}
            onClick={() => onStatus('all')}
            aria-pressed={status === 'all'}
          >
            All
          </button>
          <button
            type="button"
            className={status === 'live' ? 'on' : ''}
            onClick={() => onStatus('live')}
            aria-pressed={status === 'live'}
            title="Still accumulating"
          >
            Live
          </button>
          <button
            type="button"
            className={status === 'cooling' ? 'on' : ''}
            onClick={() => onStatus('cooling')}
            aria-pressed={status === 'cooling'}
            title="Finalized"
          >
            Cooling
          </button>
        </div>

        {/* DENSITY toggle */}
        <button
          type="button"
          className={`seg-btn${compact ? ' on' : ''}`}
          onClick={() => onCompact(!compact)}
          aria-pressed={compact}
          title={compact ? 'Switch to comfortable rows' : 'Switch to compact rows'}
          style={{ whiteSpace: 'nowrap' }}
        >
          {compact ? '▤ Compact' : '▦ Comfort'}
        </button>

        {/* GROUP BY TOKEN toggle (Wave 3) — collapse repeated bursts per token */}
        <button
          type="button"
          className={`seg-btn${groupByToken ? ' on' : ''}`}
          onClick={() => onGroupByToken(!groupByToken)}
          aria-pressed={groupByToken}
          title={groupByToken ? 'Showing one row per token — click to show every burst' : 'Show one row per token (collapse repeats)'}
          style={{ whiteSpace: 'nowrap' }}
        >
          {groupByToken ? '⊟ Grouped' : '⊞ All bursts'}
        </button>

        {/* EXECUTION settings: default terminal + default size */}
        <div className="bf-exec-prefs" title="Your default trade terminal & size">
          <label className="bf-exec-label">Ape</label>
          <select
            className="bf-exec-select"
            value={prefTerminal ?? ''}
            onChange={(e) => onSavePrefs(e.target.value || null, prefSize)}
            title="Default trade terminal — promoted as the big Ape button"
          >
            <option value="">Default terminal</option>
            {TERMINALS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            className="bf-exec-size"
            type="number"
            min={0}
            step="0.1"
            inputMode="decimal"
            placeholder="size ◎"
            value={prefSize ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value);
              onSavePrefs(prefTerminal, v != null && Number.isFinite(v) && v > 0 ? v : null);
            }}
            title="Your default position size (SOL) — a personal note shown on cards"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * PROOF HEADER — measured outcomes strip above the feed. Renders ONLY legs that
 * have data from the stats payload; never fabricates. Neutral "measuring…" state
 * when n === 0.
 */
function ProofHeader({ stats }: { stats: LiveStats | null }) {
  if (!stats) return null;
  const wh = stats.windowHours ?? null;
  const whLabel = wh != null && Number.isFinite(wh) ? `${wh}h` : 'recent window';

  if (!stats.n) {
    return (
      <div className="bf-proof">
        <span className="bf-proof-tag">measured outcomes</span>
        <span className="bf-proof-leg dim">measuring outcomes…</span>
      </div>
    );
  }

  const legs: React.ReactNode[] = [];
  if (stats.medianRet1h != null && Number.isFinite(stats.medianRet1h)) {
    legs.push(
      <span key="m1" className="bf-proof-leg">
        median <b className={stats.medianRet1h >= 0 ? 'pos' : 'neg'}>{f.pct(stats.medianRet1h)}</b> @1h
      </span>
    );
  }
  if (stats.hitRate1h != null && Number.isFinite(stats.hitRate1h)) {
    legs.push(<span key="h1" className="bf-proof-leg"><b className="pos">{Math.round(stats.hitRate1h)}%</b> green</span>);
  }
  if (stats.medianRet24h != null && Number.isFinite(stats.medianRet24h)) {
    legs.push(
      <span key="m24" className="bf-proof-leg">
        median <b className={stats.medianRet24h >= 0 ? 'pos' : 'neg'}>{f.pct(stats.medianRet24h)}</b> @24h
      </span>
    );
  }
  if (stats.hitRate24h != null && Number.isFinite(stats.hitRate24h)) {
    legs.push(<span key="h24" className="bf-proof-leg"><b className="pos">{Math.round(stats.hitRate24h)}%</b> green @24h</span>);
  }
  legs.push(<span key="n" className="bf-proof-leg dim">n={stats.n}</span>);

  const best = stats.bestCall;
  if (best && best.symbol && best.ret != null && Number.isFinite(best.ret)) {
    const inner = (
      <>best <b>{best.symbol}</b> <span className="pos">+{f.pct(best.ret)}</span></>
    );
    legs.push(
      best.mint ? (
        <a
          key="best"
          className="bf-proof-leg bf-proof-best"
          href={`/token/${best.mint}`}
          onClick={(e) => e.stopPropagation()}
        >
          {inner}
        </a>
      ) : (
        <span key="best" className="bf-proof-leg bf-proof-best">{inner}</span>
      )
    );
  }

  const today = stats.burstsToday;

  return (
    <div className="bf-proof" title="Measured forward returns of recent smart-money bursts">
      <span className="bf-proof-tag">measured · last {whLabel}</span>
      {legs.map((leg, i) => (
        <span key={i} className="bf-proof-row">
          {i > 0 && <span className="bf-proof-sep">·</span>}
          {leg}
        </span>
      ))}
      {today != null && Number.isFinite(today) && (
        <span className="bf-proof-today">{today} bursts today</span>
      )}
    </div>
  );
}

/**
 * HOTTEST-TOKENS STRIP — compact horizontal pills of the top live tokens right
 * now, ranked by a hotness score derived purely from already-loaded bursts (no
 * new fetch). Clicking a pill scrolls to that token's card (anchor `#bf-<mint>`)
 * and, failing that, navigates to /token/{mint}. Color reflects momentum.
 */
function HotStrip({
  bursts,
  onPick,
}: {
  bursts: Burst[];
  onPick: (mint: string) => void;
}) {
  const now = Date.now();
  // One entry per token (its hottest burst), ranked by hotness.
  const byMint = new Map<string, Burst>();
  for (const b of bursts) {
    const cur = byMint.get(b.mint);
    if (!cur || hotness(b, now) > hotness(cur, now)) byMint.set(b.mint, b);
  }
  const top = Array.from(byMint.values())
    .map((b) => ({ b, score: hotness(b, now) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, HOT_STRIP_SIZE);

  if (top.length < 2) return null; // not worth a strip for a single token

  const maxScore = top[0].score || 1;

  return (
    <div className="bf-hotstrip" role="navigation" aria-label="Hottest tokens right now">
      <span className="bf-hotstrip-tag">🔥 hot now</span>
      <div className="bf-hotstrip-scroll">
        {top.map(({ b, score }) => {
          const sym = b.symbol || f.short(b.mint, 3, 3);
          const vel = burstVelSolMin(b);
          const metric =
            vel != null && vel > 0 ? `${f.sol(vel)}◎/min` : `${b.buyers} buyers`;
          // Momentum band: top third = hot, mid = warm, else cool.
          const ratio = score / maxScore;
          const mom = ratio > 0.66 ? 'hot' : ratio > 0.33 ? 'warm' : 'cool';
          return (
            <button
              key={b.mint}
              type="button"
              className={`bf-hotpill ${mom}`}
              title={`${sym} — ${b.buyers} smart buyers · ${f.sol(b.solTotal)} SOL`}
              onClick={() => onPick(b.mint)}
            >
              <span className="t">{sym}</span>
              <span className="m">{metric}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// A token group: the primary (rendered) burst plus any earlier bursts collapsed
// under a "+N earlier" affordance.
interface BurstGroup {
  primary: Burst;
  others: Burst[];
}

export default function LiveFeed() {
  const router = useRouter();
  const { toggle: toggleWatch } = useWatchlist();
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [minBuyers, setMinBuyers] = useState<number>(3);
  const [windowSec, setWindowSec] = useState<number>(30);
  const [minSol, setMinSol] = useState<number>(0);
  const [sort, setSort] = useState<'quality' | 'recent'>('quality');
  const [statusFilter, setStatusFilter] = useState<'all' | 'live' | 'cooling'>('all');
  const [compact, setCompact] = useState(false);
  const [groupByToken, setGroupByToken] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  void generatedAt;

  // Per-user execution prefs (default terminal + size), hydrated after mount.
  const [prefTerminal, setPrefTerminal] = useState<string | null>(null);
  const [prefSize, setPrefSize] = useState<number | null>(null);

  // Proof-header stats (measured outcomes).
  const [stats, setStats] = useState<LiveStats | null>(null);

  // Wall-clock of the last SUCCESSFUL fetch — drives honest freshness/dot color.
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);

  // --- Wave 3 state ---
  // Price series per mint (for inline sparkline + "% since first buy"). Stored in
  // a ref (cache, with TTL) so re-polls don't refetch, plus a state mirror so the
  // UI re-renders when new series arrive. Ref is the source of truth for freshness.
  const ohlcvRef = useRef<Map<string, { at: number; series: OhlcvSeries }>>(new Map());
  const [ohlcv, setOhlcv] = useState<Record<string, OhlcvSeries>>({});
  // In-flight guard so overlapping ticks don't double-fetch the same mints.
  const ohlcvFetchingRef = useRef(false);
  // Expanded token groups ("+N earlier" toggled open), keyed by mint.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Keyboard selection: index into the flat rendered row list.
  const [selIdx, setSelIdx] = useState<number>(-1);
  // The mint of the currently selected/tapped row → drives the mobile ape bar.
  const [selMint, setSelMint] = useState<string | null>(null);
  // Optional search box (focused by `/`); present-or-not without breaking shortcuts.
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Track seen burst ids so we only highlight genuinely new cards on later polls.
  const seenRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);
  const mountedRef = useRef(true);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  // --- Axiom-style entry animation ---
  // `entering` maps a freshly-arrived burst id → its stagger index, so its group
  // can float to the TOP of the list and play the expand/glow. Ids are removed
  // after ENTER_HOLD_MS, folding the row back into the user's sorted ordering.
  // `enterOrderRef` records a monotonically-increasing arrival sequence per id so
  // the entering rows themselves stack newest-first at the very top.
  const [entering, setEntering] = useState<Map<string, number>>(new Map());
  const enterOrderRef = useRef<Map<string, number>>(new Map());
  const enterSeqRef = useRef(0);
  // Per-id removal timers so staggered/overlapping batches each clean up cleanly.
  const enterTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // `enterOpen` holds ids whose wrapper has been flipped to the open state. A row
  // mounts collapsed (grid-template-rows:0fr) and is flipped open on the NEXT
  // frame so the 0fr→1fr expand actually transitions instead of snapping. rAF
  // handle kept so we cancel a pending flip on unmount.
  const [enterOpen, setEnterOpen] = useState<Set<string>>(new Set());
  const enterRafRef = useRef<number | null>(null);

  // Re-rendered "now" tick so relative ages stay fresh between polls.
  const [, setTick] = useState(0);

  // Realtime: when connected, the browser is pushed every new trade INSERT and we
  // refetch instantly (no poll lag). null until we know; true once subscribed.
  const [realtimeOk, setRealtimeOk] = useState(false);

  // SSE: the held event-stream is the PRIMARY update path. `sseOk` is true while
  // a stream is connected AND has delivered at least one snapshot recently (the
  // watchdog clears it on connect failure / silence). Polling only runs while
  // this is false, so the two never race for long.
  const [sseOk, setSseOk] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  // Watchdog timer: if no snapshot lands within SSE_WATCHDOG_MS of (re)connect we
  // declare the stream unhealthy and let polling take over.
  const sseWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror sseOk into a ref so the realtime-INSERT handler can suppress its
  // refetch while SSE is the healthy primary path (without re-subscribing).
  const sseOkRef = useRef(false);
  sseOkRef.current = sseOk;
  // Current controls mirrored into refs so the realtime handler refetches with
  // the live filter values without re-subscribing on every control change.
  const ctrlRef = useRef({ min: minBuyers, win: windowSec, sol: minSol, sort });
  ctrlRef.current = { min: minBuyers, win: windowSec, sol: minSol, sort };
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp of the last realtime-triggered refetch, for the min-interval floor.
  const lastRealtimeFetchRef = useRef(0);

  // Hydrate execution prefs once on mount.
  useEffect(() => {
    const p = readPrefs();
    setPrefTerminal(p.terminal);
    setPrefSize(p.size);
    setGroupByToken(readGroupPref());
  }, []);

  // Persist the group-by-token toggle.
  const saveGroupByToken = useCallback((on: boolean) => {
    setGroupByToken(on);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PREF_GROUP_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  const savePrefs = useCallback((terminal: string | null, size: number | null) => {
    setPrefTerminal(terminal);
    setPrefSize(size);
    if (typeof window === 'undefined') return;
    // Ensure the device has a stable owner id (same as watchlist) before persist.
    getOwnerId();
    try {
      if (terminal) window.localStorage.setItem(PREF_TERMINAL_KEY, terminal);
      else window.localStorage.removeItem(PREF_TERMINAL_KEY);
      if (size != null) window.localStorage.setItem(PREF_SIZE_KEY, String(size));
      else window.localStorage.removeItem(PREF_SIZE_KEY);
    } catch {
      /* ignore quota / private-mode write failures */
    }
  }, []);

  // Highlight diff: flag genuinely new ids (not seen before) for the new-card
  // animation, then fold them into the seen set. On the very first delivery every
  // id is "new", so we suppress the highlight and just seed the set. Shared by the
  // poll path AND both SSE paths (snapshot + delta) so highlighting is identical.
  const flagNewIds = useCallback((incoming: Burst[]) => {
    if (firstLoadRef.current) {
      firstLoadRef.current = false;
      setNewIds(new Set());
    } else {
      const fresh = new Set<string>();
      for (const b of incoming) {
        if (!seenRef.current.has(b.id)) fresh.add(b.id);
      }
      setNewIds(fresh);
    }
    for (const b of incoming) seenRef.current.add(b.id);
  }, []);

  // SNAPSHOT path — REPLACE the burst set with the authoritative current window.
  // Used by the poll fetch and by the SSE `snapshot` event. Self-heals aged-out
  // bursts because anything no longer present is dropped.
  const applySnapshot = useCallback((next: Burst[], genAt?: string | null) => {
    flagNewIds(next);
    setBursts(next);
    setGeneratedAt(genAt ?? new Date().toISOString());
    setLastOkAt(Date.now());
    setError(null);
  }, [flagNewIds]);

  // DELTA path — UPSERT new-or-changed bursts by id into the current set, keeping
  // the incoming (freshest) fields. Order of existing rows is preserved; brand-new
  // ids are appended (client-side sort/group re-rank them on render). Used by the
  // SSE `bursts` event. Never blanks the feed.
  const upsertBursts = useCallback((delta: Burst[], genAt?: string | null) => {
    if (!delta.length) {
      setGeneratedAt(genAt ?? new Date().toISOString());
      setLastOkAt(Date.now());
      return;
    }
    flagNewIds(delta);
    setBursts((prev) => {
      const byId = new Map(prev.map((b) => [b.id, b] as const));
      for (const b of delta) byId.set(b.id, { ...byId.get(b.id), ...b });
      return Array.from(byId.values());
    });
    setGeneratedAt(genAt ?? new Date().toISOString());
    setLastOkAt(Date.now());
    setError(null);
  }, [flagNewIds]);

  const fetchLive = useCallback(async (min: number, win: number, sol: number, srt: 'quality' | 'recent') => {
    try {
      const res = await fetch(
        `/api/smart-money/live?windowSec=${win}&minBuyers=${min}&minSol=${sol}&hours=6&limit=50&sort=${srt}`
      );
      if (!res.ok) throw new Error('Failed to fetch live feed');
      const json = (await res.json()) as LiveResponse;
      if (!mountedRef.current) return;
      applySnapshot(json.bursts ?? [], json.generatedAt);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load live feed');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [applySnapshot]);

  // Proof-header stats fetch (once on mount + periodic refresh).
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/smart-money/live/stats');
      if (!res.ok) return;
      const json = (await res.json()) as LiveStats;
      if (!mountedRef.current) return;
      setStats(json);
    } catch {
      // Leave the header absent / last-known on failure — never fabricate.
    }
  }, []);

  // Initial fetch + refetch whenever the controls (incl. sort) change. Reset the
  // highlight baseline so a control change doesn't flag everything as "new".
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    firstLoadRef.current = true;
    seenRef.current = new Set();
    fetchLive(minBuyers, windowSec, minSol, sort);
    return () => { mountedRef.current = false; };
  }, [fetchLive, minBuyers, windowSec, minSol, sort]);

  // Proof stats: fetch on mount + refresh ~5 min.
  useEffect(() => {
    mountedRef.current = true;
    fetchStats();
    const t = setInterval(fetchStats, STATS_REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchStats]);

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
            // While SSE is the healthy primary path it already pushes burst
            // deltas, so skip the realtime-triggered poll to avoid running both.
            if (sseOkRef.current) return;
            const now = Date.now();
            if (now - lastRealtimeFetchRef.current < REALTIME_MIN_INTERVAL_MS) return;
            lastRealtimeFetchRef.current = now;
            fetchLive(ctrlRef.current.min, ctrlRef.current.win, ctrlRef.current.sol, ctrlRef.current.sort);
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

  // SSE PRIMARY PATH — hold one EventSource against the stream built from the
  // CURRENT filter params. The connection is rebuilt (old one closed, new one
  // opened) whenever a filter changes, mirroring the poll URL exactly. The
  // browser auto-reconnects after the server's ~50s close (via its `retry` hint)
  // and re-sends a fresh `snapshot`, which self-heals aged-out bursts.
  //
  // LIFECYCLE: open → arm watchdog → on `snapshot` REPLACE + clear watchdog +
  // mark sseOk → on `bursts` UPSERT by id → on `error` (or watchdog timeout)
  // mark !sseOk so polling takes over; the browser keeps retrying underneath and
  // the next snapshot flips sseOk back on (stopping the poll again). Teardown on
  // unmount / filter change closes the EventSource and clears the watchdog.
  useEffect(() => {
    // SSR / unsupported-browser guard → leave sseOk false so polling is primary.
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      setSseOk(false);
      return;
    }

    const clearWatchdog = () => {
      if (sseWatchdogRef.current) {
        clearTimeout(sseWatchdogRef.current);
        sseWatchdogRef.current = null;
      }
    };
    const armWatchdog = () => {
      clearWatchdog();
      sseWatchdogRef.current = setTimeout(() => {
        // No snapshot within the window → treat as unhealthy, fall back to poll.
        if (mountedRef.current) setSseOk(false);
      }, SSE_WATCHDOG_MS);
    };

    // Public browser SSE (snapshot + deltas). The API-key-gated bot stream lives
    // separately at /api/smart-money/live/stream — don't point the UI at it.
    const url =
      `/api/smart-money/live/ui-stream?windowSec=${windowSec}&minBuyers=${minBuyers}` +
      `&minSol=${minSol}&hours=6&limit=50&sort=${sort}`;

    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch {
      setSseOk(false);
      return;
    }
    esRef.current = es;
    armWatchdog();

    es.addEventListener('snapshot', (ev: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const json = JSON.parse(ev.data) as LiveResponse;
        applySnapshot(json.bursts ?? [], json.generatedAt);
        clearWatchdog();
        setSseOk(true);
        setLoading(false);
      } catch {
        /* malformed frame — ignore, keep last set */
      }
    });

    es.addEventListener('bursts', (ev: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const json = JSON.parse(ev.data) as { bursts?: Burst[]; generatedAt?: string };
        upsertBursts(json.bursts ?? [], json.generatedAt);
        // A delta proves the stream is alive even if the watchdog hasn't seen a
        // snapshot yet (shouldn't happen, but keeps us healthy & re-arms).
        clearWatchdog();
        setSseOk(true);
      } catch {
        /* ignore */
      }
    });

    es.onerror = () => {
      // EventSource auto-reconnects on its own; we just drop to polling meanwhile.
      // Never blank the feed — the last burst set stays on screen.
      if (mountedRef.current) setSseOk(false);
      // Re-arm so a stalled-but-not-closed socket still trips the fallback.
      armWatchdog();
    };

    return () => {
      clearWatchdog();
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [applySnapshot, upsertBursts, minBuyers, windowSec, minSol, sort]);

  // Poll for the current controls — FALLBACK only. Skipped entirely while SSE is
  // the healthy primary path (sseOk). When SSE is down: if Realtime is pushing
  // this drops to a slow safety net; otherwise it's the primary 3s refresh.
  useEffect(() => {
    if (sseOk) return; // SSE is primary — don't run both at once.
    const pollMs = realtimeOk ? 30_000 : POLL_MS;
    const interval = setInterval(() => fetchLive(minBuyers, windowSec, minSol, sort), pollMs);
    return () => clearInterval(interval);
  }, [fetchLive, minBuyers, windowSec, minSol, sort, realtimeOk, sseOk]);

  // Keep relative ages ticking between polls (every 5s is plenty).
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // STATUS filter (client-side): Live = !finalized; Cooling = finalized.
  const visible = useMemo(
    () =>
      bursts.filter((b) => {
        if (statusFilter === 'all') return true;
        if (statusFilter === 'live') return b.finalized === false;
        return b.finalized === true; // cooling
      }),
    [bursts, statusFilter]
  );

  // GROUP BY TOKEN (Wave 3): collapse repeated bursts per mint to one primary row
  // (preserving the server's overall order by first-appearance), with the rest
  // available under "+N earlier". When off, each burst is its own group.
  const groups: BurstGroup[] = useMemo(() => {
    if (!groupByToken) return visible.map((b) => ({ primary: b, others: [] }));
    const order: string[] = [];
    const byMint = new Map<string, Burst[]>();
    for (const b of visible) {
      if (!byMint.has(b.mint)) {
        byMint.set(b.mint, []);
        order.push(b.mint);
      }
      byMint.get(b.mint)!.push(b);
    }
    return order.map((mint) => {
      const list = byMint.get(mint)!;
      const primary = list.reduce((acc, b) => pickPrimary(acc, b));
      const others = list.filter((b) => b.id !== primary.id);
      // Show earlier bursts newest-first.
      others.sort((a, b) => (ms(b.windowEnd) ?? 0) - (ms(a.windowEnd) ?? 0));
      return { primary, others };
    });
  }, [visible, groupByToken]);

  // DISPLAY ORDER — Axiom live-feed feel: groups whose primary is currently
  // "entering" (a genuinely-new burst flagged in the last ~ENTER_HOLD_MS) float to
  // the TOP, newest arrival first (by the monotonic enterOrderRef sequence), ahead
  // of the user's already-sorted/grouped rest. Once an id's hold expires it leaves
  // `entering` and the group folds back into its natural sorted position. This is
  // what makes a fresh cluster visibly enter at the top while the rest stay put.
  const displayGroups: BurstGroup[] = useMemo(() => {
    if (entering.size === 0) return groups;
    const fresh: BurstGroup[] = [];
    const rest: BurstGroup[] = [];
    for (const g of groups) {
      if (entering.has(g.primary.id)) fresh.push(g);
      else rest.push(g);
    }
    if (fresh.length === 0) return groups;
    // Newest arrival first: higher enter sequence ranks earlier.
    fresh.sort(
      (a, b) =>
        (enterOrderRef.current.get(b.primary.id) ?? 0) -
        (enterOrderRef.current.get(a.primary.id) ?? 0)
    );
    return [...fresh, ...rest];
  }, [groups, entering]);

  // Flat list of rows actually rendered (primaries + any expanded children), in
  // render order — the index space the keyboard selection / ape bar operate on.
  // Built from displayGroups so keyboard nav / ape bar match the on-screen order.
  const rows: Burst[] = useMemo(() => {
    const out: Burst[] = [];
    for (const g of displayGroups) {
      out.push(g.primary);
      if (expandedGroups.has(g.primary.mint)) out.push(...g.others);
    }
    return out;
  }, [displayGroups, expandedGroups]);

  // The set of mints currently on screen (capped) — the only thing we fetch
  // OHLCV for. Deduped & bounded so a single batch request stays cheap.
  const visibleMints = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const g of groups) {
      if (!seen.has(g.primary.mint)) {
        seen.add(g.primary.mint);
        list.push(g.primary.mint);
      }
      if (list.length >= OHLCV_MAX_MINTS) break;
    }
    return list;
  }, [groups]);

  // Stable key for the visible-mint SET so the OHLCV effect runs only when the
  // set of tokens on screen changes — NOT on every 3s poll tick.
  const visibleMintsKey = useMemo(
    () => [...visibleMints].sort().join(','),
    [visibleMints]
  );

  // --- Wave 3: batch-fetch price candles for the visible mints, bounded. ---
  // Fires on the visible-mint-SET change (via visibleMintsKey), not the poll
  // tick: re-polls that return the same tokens reuse the cached series. Only
  // mints whose cached series is missing or older than OHLCV_TTL_MS are fetched.
  const fetchOhlcv = useCallback(async () => {
    if (ohlcvFetchingRef.current) return;
    const now = Date.now();
    const stale = visibleMints.filter((m) => {
      const hit = ohlcvRef.current.get(m);
      return !hit || now - hit.at > OHLCV_TTL_MS;
    });
    if (!stale.length) return;
    ohlcvFetchingRef.current = true;
    try {
      const mints = stale.slice(0, OHLCV_MAX_MINTS).join(',');
      const res = await fetch(`/api/token/ohlcv/batch?mints=${encodeURIComponent(mints)}&tf=1h`);
      if (!res.ok) return;
      const json = (await res.json()) as OhlcvBatchResponse;
      if (!mountedRef.current) return;
      const at = Date.now();
      const results = json.results ?? {};
      for (const [mint, series] of Object.entries(results)) {
        if (series && Array.isArray(series.closes) && series.closes.length) {
          ohlcvRef.current.set(mint, { at, series });
        }
      }
      // Mirror cache → state so cards re-render with their sparklines.
      const mirror: Record<string, OhlcvSeries> = {};
      for (const [mint, v] of ohlcvRef.current.entries()) mirror[mint] = v.series;
      setOhlcv(mirror);
    } catch {
      // Leave whatever series we already have — never fabricate.
    } finally {
      ohlcvFetchingRef.current = false;
    }
  }, [visibleMints]);

  // Run the OHLCV fetch only when the visible-mint set changes.
  useEffect(() => {
    if (loading || !visibleMints.length) return;
    fetchOhlcv();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleMintsKey, loading]);

  // Keep the keyboard selection in range as rows change.
  useEffect(() => {
    if (selIdx >= rows.length) setSelIdx(rows.length ? rows.length - 1 : -1);
  }, [rows.length, selIdx]);

  // --- Wave 3: keyboard shortcuts (desktop power users) ---
  // j/k move selection, Enter opens the selected burst's preferred terminal,
  // w toggles watch, / focuses search. Ignored while typing in an input.
  useEffect(() => {
    function isTyping(el: EventTarget | null): boolean {
      const t = el as HTMLElement | null;
      if (!t) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        if (searchRef.current && !isTyping(e.target)) {
          e.preventDefault();
          searchRef.current.focus();
        }
        return;
      }
      if (isTyping(e.target)) return;
      if (!rows.length) return;
      if (e.key === 'j') {
        e.preventDefault();
        const next = Math.min(rows.length - 1, (selIdx < 0 ? -1 : selIdx) + 1);
        setSelIdx(next);
        setSelMint(rows[next]?.mint ?? null);
      } else if (e.key === 'k') {
        e.preventDefault();
        const next = Math.max(0, (selIdx < 0 ? rows.length : selIdx) - 1);
        setSelIdx(next);
        setSelMint(rows[next]?.mint ?? null);
      } else if (e.key === 'Enter') {
        const b = rows[selIdx];
        if (!b) return;
        const links = tokenLinks(b.mint, { pairAddress: b.pairAddress ?? undefined });
        let primary = prefTerminal
          ? links.find((l) => l.kind === 'trade' && l.label.toLowerCase() === prefTerminal.toLowerCase())
          : undefined;
        if (!primary) primary = links.find((l) => l.kind === 'trade');
        if (primary && typeof window !== 'undefined') {
          window.open(primary.url, '_blank', 'noopener,noreferrer');
        }
      } else if (e.key === 'w') {
        const b = rows[selIdx];
        if (b) {
          e.preventDefault();
          toggleWatch(b.mint);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selIdx, prefTerminal, toggleWatch]);

  // ENTRY ORCHESTRATION — react to genuinely-new ids (flagged by flagNewIds into
  // `newIds`; empty on first load so the initial snapshot never animates). For
  // each not-already-entering id: assign it an arrival sequence (newest-first
  // ordering at the top) and a capped stagger index, mark it entering, then
  // schedule its removal after the expand+glow completes. Under reduced motion we
  // skip the animation entirely — ids still surface at top briefly via the same
  // bookkeeping, but the CSS renders them in place with no motion.
  useEffect(() => {
    if (newIds.size === 0) return;
    const reduce = prefersReducedMotion();
    // Only ids we aren't already animating; cap how many get a staggered entry.
    const fresh: string[] = [];
    for (const id of newIds) {
      if (!enterOrderRef.current.has(id)) fresh.push(id);
    }
    if (fresh.length === 0) return;

    setEntering((prev) => {
      const next = new Map(prev);
      fresh.forEach((id, i) => {
        enterOrderRef.current.set(id, ++enterSeqRef.current);
        // Cap the staggered/animated set so a 50-row snapshot can't animate all.
        const staggerIdx = i < ENTER_MAX_ANIMATED ? i : ENTER_MAX_ANIMATED - 1;
        next.set(id, reduce ? 0 : staggerIdx);
        // Schedule fold-back into the sorted list once the entry finishes.
        const prevTimer = enterTimersRef.current.get(id);
        if (prevTimer) clearTimeout(prevTimer);
        const hold = reduce ? 0 : ENTER_HOLD_MS + staggerIdx * ENTER_STAGGER_MS;
        const t = setTimeout(() => {
          if (!mountedRef.current) return;
          enterTimersRef.current.delete(id);
          enterOrderRef.current.delete(id);
          setEntering((cur) => {
            if (!cur.has(id)) return cur;
            const m = new Map(cur);
            m.delete(id);
            return m;
          });
        }, hold);
        enterTimersRef.current.set(id, t);
      });
      return next;
    });
  }, [newIds]);

  // OPEN/CLOSE the entry wrappers. Entering rows mount collapsed; we flip them to
  // the open state on the next animation frame so the grid-template-rows 0fr→1fr
  // expand (which drives the smooth push-down of the rows below) actually
  // transitions. When an id leaves `entering` (its hold expired) we drop it from
  // the open set too, so a later re-arrival animates again from collapsed.
  useEffect(() => {
    // Prune ids that are no longer entering.
    setEnterOpen((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (!entering.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
    // Any entering id not yet open → open it on the next frame.
    const toOpen: string[] = [];
    for (const id of entering.keys()) {
      if (!enterOpen.has(id)) toOpen.push(id);
    }
    if (toOpen.length === 0) return;
    if (enterRafRef.current != null) cancelAnimationFrame(enterRafRef.current);
    enterRafRef.current = requestAnimationFrame(() => {
      enterRafRef.current = null;
      if (!mountedRef.current) return;
      setEnterOpen((prev) => {
        const next = new Set(prev);
        for (const id of toOpen) next.add(id);
        return next;
      });
    });
  }, [entering, enterOpen]);

  // Clear all entry timers (and any pending open-frame) on unmount.
  useEffect(() => {
    const timers = enterTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (enterRafRef.current != null) cancelAnimationFrame(enterRafRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div className="view stack gap-24">
        <Header
          minBuyers={minBuyers} onMinBuyers={setMinBuyers}
          windowSec={windowSec} onWindowSec={setWindowSec}
          minSol={minSol} onMinSol={setMinSol}
          sort={sort} onSort={setSort}
          status={statusFilter} onStatus={setStatusFilter}
          compact={compact} onCompact={setCompact}
          groupByToken={groupByToken} onGroupByToken={saveGroupByToken}
          prefTerminal={prefTerminal} prefSize={prefSize} onSavePrefs={savePrefs}
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
          sort={sort} onSort={setSort}
          status={statusFilter} onStatus={setStatusFilter}
          compact={compact} onCompact={setCompact}
          groupByToken={groupByToken} onGroupByToken={saveGroupByToken}
          prefTerminal={prefTerminal} prefSize={prefSize} onSavePrefs={savePrefs}
        />
        <div className="card">
          <ErrorState
            msg="The live feed didn’t respond."
            onRetry={() => { setLoading(true); fetchLive(minBuyers, windowSec, minSol, sort); }}
          />
        </div>
      </div>
    );
  }

  // HONEST FRESHNESS — color the live dot by actual state instead of a
  // hardcoded green. Driven by the last received event (snapshot/delta/poll via
  // lastOkAt). Green when a live push channel (SSE stream, else Realtime) is
  // connected AND the last event is recent; amber when we've dropped to polling
  // or the last event went stale; grey before the first successful event.
  const sinceOk = lastOkAt == null ? Infinity : Date.now() - lastOkAt;
  const stale = sinceOk > STALE_MS;
  const livePush = sseOk || realtimeOk;
  const freshness =
    lastOkAt == null
      ? { color: DOT_NEUTRAL, label: 'connecting…' }
      : livePush && !stale
      ? { color: CHART_COLORS.POS, label: sseOk ? 'live — streaming updates' : 'live — updates instantly' }
      : !livePush
      ? { color: DOT_WARN, label: 'reconnecting… — polling every 3s' }
      : { color: DOT_WARN, label: 'stale — retrying…' };

  // The currently selected burst (for the mobile ape bar), looked up by mint
  // among the rendered rows.
  const selBurst = selMint != null ? rows.find((r) => r.mint === selMint) ?? null : null;

  // Scroll to a token's card from the hot strip; fall back to its page.
  const jumpToMint = (mint: string) => {
    if (typeof document !== 'undefined') {
      const el = document.getElementById(`bf-${mint}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setSelMint(mint);
        const idx = rows.findIndex((r) => r.mint === mint);
        if (idx >= 0) setSelIdx(idx);
        return;
      }
    }
    router.push(`/token/${mint}`);
  };

  // Render one burst row. `rowIndex` is its position in the flat keyboard/ape
  // index space; `group` carries the "+N earlier" affordance for primaries.
  const renderRow = (b: Burst, rowIndex: number, group: BurstGroup, isChild: boolean): React.ReactNode => {
    const now = Date.now();
    const symbol = b.symbol || f.short(b.mint, 4, 4);
    const startMs = ms(b.windowStart);
    const endMs = ms(b.windowEnd);
    const spanSec =
      startMs != null && endMs != null
        ? Math.max(0, Math.round((endMs - startMs) / 1000))
        : null;
    const durLabel =
      spanSec == null
        ? null
        : spanSec >= 60
        ? `over ${Math.round(spanSec / 60)}m`
        : `over ${spanSec}s`;
    const isNew = newIds.has(b.id);
    const sample = b.sampleBuyers.slice(0, 4);
    const tiers = b.tiers ?? [];
    const buyerStats = b.buyerStats ?? [];
    const tierSummary = tiers.filter((t): t is string => !!t).join('·');
    const isTrap = b.buyerWallets >= 2 * b.buyers && b.buyers > 0;
    const isIndependent = !isTrap && b.buyers > 0 && b.buyerWallets <= b.buyers + 1;
    const mcap = usdCompact(b.marketCapUsd);
    const liq = usdCompact(b.liquidityUsd);
    const chg = b.priceChange24h;
    const vol = usdCompact(b.volume24hUsd);
    const tier = mcapTier(b.marketCapUsd);
    const mintLive = b.mintRenounced === false;
    const freezeLive = b.freezeRenounced === false;
    const bothSafe = b.mintRenounced === true && b.freezeRenounced === true;
    const noSells = b.sells24h === 0 && (b.buys24h ?? 0) > 5;
    const liqMcRatio =
      b.liquidityUsd != null && b.marketCapUsd != null && b.marketCapUsd > 0
        ? b.liquidityUsd / b.marketCapUsd
        : null;
    const thinLiq = liqMcRatio != null && liqMcRatio < THIN_LIQ_RATIO;
    const lowLiq = liqMcRatio == null && b.liquidityUsd != null && b.liquidityUsd < LOW_LIQ_USD;
    const whale = b.topHolderPct != null && Number.isFinite(b.topHolderPct) && b.topHolderPct > WHALE_PCT;
    const createdMs = ms(b.pairCreatedAt);
    const ageLabel = createdMs != null ? ageShort(createdMs, now) : null;
    const veryNew = createdMs != null && now - createdMs < VERY_NEW_MS;
    const velSolMin = spanSec != null && spanSec > 0 ? (b.solTotal / spanSec) * 60 : null;
    const hasSafetyRow =
      mintLive || freezeLive || bothSafe || ageLabel || noSells || thinLiq || lowLiq || whale;
    const isLive = b.finalized === false;

    // --- Wave 3: price sparkline + "% since first buy" from OHLCV series. ---
    const series = ohlcv[b.mint];
    const closes = series?.closes ?? [];
    const hasSpark = closes.length >= 2;
    const sparkUp = hasSpark ? closes[closes.length - 1] >= closes[0] : true;
    const sparkColor = sparkUp ? CHART_COLORS.POS : CHART_COLORS.NEG;
    // % since first burst buy: baseline = close nearest windowStart.
    let sinceFirst: number | null = null;
    if (series && series.times.length === series.closes.length && series.closes.length >= 2 && startMs != null) {
      let bestI = -1;
      let bestD = Infinity;
      for (let i = 0; i < series.times.length; i++) {
        const d = Math.abs(series.times[i] - startMs);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      const base = bestI >= 0 ? series.closes[bestI] : null;
      const last = series.closes[series.closes.length - 1];
      if (base != null && base > 0 && Number.isFinite(last)) {
        sinceFirst = ((last - base) / base) * 100;
      }
    }

    const isSelected = rowIndex === selIdx || (selMint != null && selMint === b.mint && !isChild);
    const earlierCount = !isChild ? group.others.length : 0;
    const expanded = expandedGroups.has(group.primary.mint);

    // Axiom-style entry: this burst is freshly-arrived and within its animation
    // hold. The wrapper (added at the end of this fn) expands 0fr→1fr to push the
    // rows below down; `staggerMs` cascades a batch of arrivals.
    const isEntering = entering.has(b.id);
    const staggerMs = isEntering ? (entering.get(b.id) ?? 0) * ENTER_STAGGER_MS : 0;

    const rowEl = (
      <div
        key={b.id}
        id={isChild ? undefined : `bf-${b.mint}`}
        className={`bf-row${isNew ? ' is-new' : ''}${isSelected ? ' is-selected' : ''}${isChild ? ' bf-row-child' : ''}`}
        onClick={() => {
          setSelMint(b.mint);
          setSelIdx(rowIndex);
          router.push(`/token/${b.mint}`);
        }}
      >
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
            {/* Inline price sparkline + % since first buy (Wave 3) */}
            {hasSpark && (
              <div className="bf-spark" title="Price, last ~7d (1h candles)">
                <Sparkline values={closes} width={84} height={26} color={sparkColor} />
                {sinceFirst != null && (
                  <span
                    className={`bf-since ${sinceFirst >= 0 ? 'pos' : 'neg'}`}
                    title="Price change since this burst's first buy — still early or gone?"
                  >
                    {sinceFirst >= 0 ? '▲' : '▼'} {f.pct(sinceFirst)} since first buy
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="bf-hero">
            <span className="bf-sol">
              {f.sol(b.solTotal)}<span className="unit">SOL</span>
            </span>
            <span className="bf-wallets">
              <b>{b.buyers}</b> smart {b.buyers === 1 ? 'wallet' : 'wallets'}
            </span>
            {tierSummary && (
              <span className="bf-tiermix" title="Tiers of the sampled buyers (conviction at a glance)">
                {tierSummary}
              </span>
            )}
            {velSolMin != null && velSolMin > 0 && (
              <span className="bf-velocity" title="Buying velocity over the burst window">
                🔥 {f.sol(velSolMin)}◎/min
              </span>
            )}
          </div>

          {hasSafetyRow && (
            <div className="bf-badges">
              {mintLive && (
                <span className="bf-chip danger" title="Mint authority NOT renounced — dev can mint more supply">
                  MINT LIVE
                </span>
              )}
              {freezeLive && (
                <span className="bf-chip danger" title="Freeze authority NOT renounced — possible honeypot">
                  FREEZE
                </span>
              )}
              {bothSafe && (
                <span className="bf-chip safe" title="Mint & freeze authorities both renounced">
                  ✓ safe
                </span>
              )}
              {ageLabel && (
                <span
                  className={`bf-chip${veryNew ? ' danger' : ' neutral'}`}
                  title={veryNew ? 'Very new token — elevated rug risk' : 'Token age'}
                >
                  ⏳ {ageLabel} old
                </span>
              )}
              {noSells && (
                <span className="bf-chip danger" title="Buys but zero sells in 24h — possible honeypot (can't sell)">
                  NO SELLS
                </span>
              )}
              {thinLiq && (
                <span
                  className="bf-chip danger"
                  title={`Liquidity is ${(liqMcRatio! * 100).toFixed(1)}% of market cap — thin, high rug risk`}
                >
                  THIN LIQ
                </span>
              )}
              {lowLiq && (
                <span className="bf-chip danger" title={`Liquidity under $${LOW_LIQ_USD / 1000}k — high rug risk`}>
                  LOW LIQ
                </span>
              )}
              {whale && (
                <span className="bf-chip warn" title="Top holder controls a large share of supply">
                  WHALE {Math.round(b.topHolderPct!)}%
                </span>
              )}
            </div>
          )}

          {(b.leadBuyer || b.leadTier || b.smartSetSize != null || isIndependent || isTrap) && (
            <div className="bf-sub">
              {(b.leadBuyer || b.leadTier) && (
                <span className="bf-lead" title={b.leadBuyer ? `First to buy: ${b.leadBuyer}` : 'First wallet to buy'}>
                  🥇 lead{b.leadTier ? `: ${b.leadTier}-tier` : ''}
                </span>
              )}
              {b.smartSetSize != null && b.smartSetSize > 0 && (
                <span title="Share of the known smart-wallet set that bought">
                  {b.buyers} of ~{b.smartSetSize} smart in ({Math.round((b.buyers / b.smartSetSize) * 100)}%)
                </span>
              )}
              {isIndependent && (
                <span className="bf-indep" title="Wallet count ≈ entity count — a genuine independent crowd">
                  {b.buyers} independent
                </span>
              )}
              {isTrap && (
                <span className="bf-trap" title="Many wallets map to few entities — likely one actor faking a crowd">
                  TRAP · {b.buyerWallets}w / {b.buyers}e
                </span>
              )}
            </div>
          )}

          {(mcap || liq || vol || (chg != null && Number.isFinite(chg)) || durLabel) && (
            <div className="bf-metrics">
              {mcap && (
                <div className="bf-metric">
                  <span className="k">MC{tier ? ` · ${tier}` : ''}</span>
                  <span className="v">{mcap}</span>
                </div>
              )}
              {liq && (
                <div className="bf-metric">
                  <span className="k">Liq</span>
                  <span className="v">{liq}</span>
                </div>
              )}
              {vol && (
                <div className="bf-metric">
                  <span className="k">Vol 24h</span>
                  <span className="v">{vol}</span>
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
            </div>
          )}

          {sample.length > 0 && (
            <div className="bf-buyers">
              {sample.map((addr, i) => {
                const bs = buyerStats[i];
                const roi = bs?.roiPct;
                const t = bs?.tier ?? (tiers[i] ?? null);
                const wr = bs?.winRate;
                const roiLabel =
                  roi != null && Number.isFinite(roi)
                    ? `${roi >= 0 ? '+' : ''}${Math.round(roi)}%`
                    : null;
                return (
                  <span key={addr} className="bf-buyer">
                    <AddrChip address={addr} />
                    {t && <TierBadge tier={t} />}
                    {roiLabel && (
                      <span
                        className={`bf-roi ${roi! >= 0 ? 'pos' : 'neg'}`}
                        title={wr != null && Number.isFinite(wr) ? `Win rate ${Math.round(wr)}%` : 'Historical ROI'}
                      >
                        {roiLabel}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}

          {/* "+N earlier" affordance — collapse repeated bursts per token (Wave 3) */}
          {earlierCount > 0 && (
            <button
              type="button"
              className="bf-more"
              aria-expanded={expanded}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setExpandedGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.primary.mint)) next.delete(group.primary.mint);
                  else next.add(group.primary.mint);
                  return next;
                });
              }}
              title={expanded ? 'Hide earlier bursts for this token' : 'Show earlier bursts for this token'}
            >
              {expanded ? '▾ hide earlier' : `+${earlierCount} earlier burst${earlierCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>

        <div className="bf-right">
          <div className="bf-right-top">
            {isLive ? (
              <span className="bf-status live" title="This burst is still being added to">
                <span className="dot" aria-hidden /> Live
              </span>
            ) : (
              <span className="bf-status ended" title={`Burst ended ${f.ago(endMs)}`}>
                ended
              </span>
            )}
            <ShareButton burst={b} symbol={symbol} />
            <BurstWatchStar mint={b.mint} />
          </div>
          {(prefSize != null || b.suggestedSizeSol != null) && (
            <span className="bf-size-hint" title="Suggested starting size — a hint, not advice">
              {prefSize != null
                ? `your ${f.sol(prefSize)}◎`
                : `suggested ${f.sol(b.suggestedSizeSol)}◎`}
            </span>
          )}
          <div className="bf-actions">
            <TradeLinks
              mint={b.mint}
              size="xs"
              primary
              preferred={prefTerminal ?? undefined}
              pairAddress={b.pairAddress ?? undefined}
            />
          </div>
        </div>
      </div>
    );

    // Not entering → render the row directly (it carries its own key).
    if (!isEntering) return rowEl;

    // Entering → wrap in the grid-template-rows 0fr→1fr expander. The inner clips
    // overflow so the wrapper's height grows from 0 to the row's natural height,
    // sliding the rows below down with no fixed max-height guess. `bf-enter-open`
    // is added on the next frame (see enterOpen effect) to trigger the transition.
    return (
      <div
        key={b.id}
        className={`bf-enter${enterOpen.has(b.id) ? ' bf-enter-open' : ''}`}
        style={{ ['--bf-stagger' as string]: `${staggerMs}ms` }}
      >
        <div className="bf-enter-inner">{rowEl}</div>
      </div>
    );
  };

  return (
    <div className="view stack gap-16">
      <Header
        minBuyers={minBuyers} onMinBuyers={setMinBuyers}
        windowSec={windowSec} onWindowSec={setWindowSec}
        minSol={minSol} onMinSol={setMinSol}
        sort={sort} onSort={setSort}
        status={statusFilter} onStatus={setStatusFilter}
        compact={compact} onCompact={setCompact}
        groupByToken={groupByToken} onGroupByToken={saveGroupByToken}
        prefTerminal={prefTerminal} prefSize={prefSize} onSavePrefs={savePrefs}
      />

      <ProofHeader stats={stats} />

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

      {/* HOTTEST-TOKENS STRIP (Wave 3) — derived purely from loaded bursts. */}
      <HotStrip bursts={visible} onPick={jumpToMint} />

      {visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Radio}
            title="No bursts yet"
            msg={`Bursts appear when ≥${minBuyers} smart wallets pile into the same token within ${windowSec}s.`}
          />
        </div>
      ) : (
        <div className={`bf-list stack gap-8${compact ? ' compact' : ''}`}>
          {(() => {
            // Render groups in DISPLAY order (entering bursts floated to the top);
            // each primary row gets a flat row index used by keyboard selection +
            // the mobile ape bar. Expanded children follow their primary and
            // continue the same index space.
            const out: React.ReactNode[] = [];
            let rowIdx = 0;
            for (const g of displayGroups) {
              const expanded = expandedGroups.has(g.primary.mint);
              out.push(renderRow(g.primary, rowIdx++, g, false));
              if (expanded) {
                for (const child of g.others) {
                  out.push(renderRow(child, rowIdx++, g, true));
                }
              }
            }
            return out;
          })()}
        </div>
      )}

      {/* MOBILE STICKY APE BAR (Wave 3) — one-thumb execution on small screens. */}
      {selBurst && (
        <div className="bf-apebar" role="region" aria-label="Quick trade">
          <div className="bf-apebar-id">
            <span className="bf-apebar-tk">{selBurst.symbol || f.short(selBurst.mint, 4, 4)}</span>
            <span className="bf-apebar-sub mono">{f.short(selBurst.mint, 4, 4)}</span>
          </div>
          {(() => {
            const links = tokenLinks(selBurst.mint, { pairAddress: selBurst.pairAddress ?? undefined });
            let primary = prefTerminal
              ? links.find((l) => l.kind === 'trade' && l.label.toLowerCase() === prefTerminal.toLowerCase())
              : undefined;
            if (!primary) primary = links.find((l) => l.kind === 'trade');
            if (!primary) return null;
            return (
              <a
                className="bf-apebar-btn"
                href={primary.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`Trade on ${primary.label}`}
              >
                Ape · {primary.label}
              </a>
            );
          })()}
          <button
            type="button"
            className="bf-apebar-close"
            aria-label="Dismiss"
            onClick={() => { setSelMint(null); setSelIdx(-1); }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Keyboard-shortcut hint (desktop). */}
      <div className="bf-kbd-hint" aria-hidden>
        <span className="bf-kbd">?</span> shortcuts:
        <span className="bf-kbd">j</span>/<span className="bf-kbd">k</span> move
        <span className="bf-kbd">↵</span> ape
        <span className="bf-kbd">w</span> watch
      </div>

      <style>{`
        @keyframes lf-fade-in {
          from { opacity: 0.35; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
