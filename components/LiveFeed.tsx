'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Radio, Star } from 'lucide-react';
import * as f from '@/lib/format';
import { getBrowserSupabase } from '@/lib/supabase-browser';
import { useWatchlist } from '@/lib/useWatchlist';
import {
  TokenMark, TradeLinks, AddrChip, TierBadge, EmptyState, ErrorState,
  SkTable, SkCard, CHART_COLORS,
} from '@/components/ui';

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

export default function LiveFeed() {
  const router = useRouter();
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [minBuyers, setMinBuyers] = useState<number>(3);
  const [windowSec, setWindowSec] = useState<number>(30);
  const [minSol, setMinSol] = useState<number>(0);
  const [sort, setSort] = useState<'quality' | 'recent'>('quality');
  const [statusFilter, setStatusFilter] = useState<'all' | 'live' | 'cooling'>('all');
  const [compact, setCompact] = useState(false);
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

  const fetchLive = useCallback(async (min: number, win: number, sol: number, srt: 'quality' | 'recent') => {
    try {
      const res = await fetch(
        `/api/smart-money/live?windowSec=${win}&minBuyers=${min}&minSol=${sol}&hours=6&limit=50&sort=${srt}`
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

  // Poll for the current controls. When Realtime is pushing, this drops to a slow
  // safety net (catches missed events / dropped sockets); otherwise it's the
  // primary 3s refresh.
  useEffect(() => {
    const pollMs = realtimeOk ? 30_000 : POLL_MS;
    const interval = setInterval(() => fetchLive(minBuyers, windowSec, minSol, sort), pollMs);
    return () => clearInterval(interval);
  }, [fetchLive, minBuyers, windowSec, minSol, sort, realtimeOk]);

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
          sort={sort} onSort={setSort}
          status={statusFilter} onStatus={setStatusFilter}
          compact={compact} onCompact={setCompact}
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

  // STATUS filter (client-side): Live = !finalized; Cooling = finalized.
  const visible = bursts.filter((b) => {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'live') return b.finalized === false;
    return b.finalized === true; // cooling
  });

  return (
    <div className="view stack gap-16">
      <Header
        minBuyers={minBuyers} onMinBuyers={setMinBuyers}
        windowSec={windowSec} onWindowSec={setWindowSec}
        minSol={minSol} onMinSol={setMinSol}
        sort={sort} onSort={setSort}
        status={statusFilter} onStatus={setStatusFilter}
        compact={compact} onCompact={setCompact}
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
          {visible.map((b) => {
            const now = Date.now();
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
            const buyerStats = b.buyerStats ?? [];

            // Compact conviction summary from the present tiers, e.g. "S·A·B".
            const tierSummary = tiers.filter((t): t is string => !!t).join('·');

            // TRAP heuristic: many wallets attributed to few entities → likely
            // one actor faking a crowd. Promote to a visible warning chip.
            const isTrap = b.buyerWallets >= 2 * b.buyers && b.buyers > 0;
            // Independence (flip of trap): wallets ≈ entities → genuine crowd.
            const isIndependent = !isTrap && b.buyers > 0 && b.buyerWallets <= b.buyers + 1;

            const mcap = usdCompact(b.marketCapUsd);
            const liq = usdCompact(b.liquidityUsd);
            const chg = b.priceChange24h;
            const vol = usdCompact(b.volume24hUsd);
            const tier = mcapTier(b.marketCapUsd);

            // --- SAFETY signals ---
            const mintLive = b.mintRenounced === false;     // dev can still mint
            const freezeLive = b.freezeRenounced === false;  // honeypot risk
            const bothSafe = b.mintRenounced === true && b.freezeRenounced === true;
            // Honeypot proxy: zero sells with meaningful buys.
            const noSells = b.sells24h === 0 && (b.buys24h ?? 0) > 5;
            // Liquidity health: thin liq relative to MC supersedes flat low-liq.
            const liqMcRatio =
              b.liquidityUsd != null && b.marketCapUsd != null && b.marketCapUsd > 0
                ? b.liquidityUsd / b.marketCapUsd
                : null;
            const thinLiq = liqMcRatio != null && liqMcRatio < THIN_LIQ_RATIO;
            // Flat low-liq fallback (only when we can't compute the ratio).
            const lowLiq = liqMcRatio == null && b.liquidityUsd != null && b.liquidityUsd < LOW_LIQ_USD;
            // Whale concentration.
            const whale = b.topHolderPct != null && Number.isFinite(b.topHolderPct) && b.topHolderPct > WHALE_PCT;
            // Token age.
            const createdMs = ms(b.pairCreatedAt);
            const ageLabel = createdMs != null ? ageShort(createdMs, now) : null;
            const veryNew = createdMs != null && now - createdMs < VERY_NEW_MS;

            // --- VELOCITY ---
            const velSolMin =
              spanSec != null && spanSec > 0 ? (b.solTotal / spanSec) * 60 : null;

            const hasSafetyRow =
              mintLive || freezeLive || bothSafe || ageLabel || noSells || thinLiq || lowLiq || whale;

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
                    {velSolMin != null && velSolMin > 0 && (
                      <span className="bf-velocity" title="Buying velocity over the burst window">
                        🔥 {f.sol(velSolMin)}◎/min
                      </span>
                    )}
                  </div>

                  {/* SAFETY / RUG badges — loss prevention */}
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

                  {/* CONVICTION: lead buyer + coverage + independence/trap */}
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
                        <span
                          className="bf-trap"
                          title="Many wallets map to few entities — likely one actor faking a crowd"
                        >
                          TRAP · {b.buyerWallets}w / {b.buyers}e
                        </span>
                      )}
                    </div>
                  )}

                  {/* Compact metric strip — render only fields that are present */}
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
                </div>

                {/* RIGHT: live/ended status on top, prominent Ape + subdued links below */}
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
