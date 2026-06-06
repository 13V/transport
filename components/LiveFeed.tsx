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
              title={`Group buys within a ${w}s window`}
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
        <div className="stack gap-12">
          {bursts.map((b) => {
            const symbol = b.symbol || f.short(b.mint, 4, 4);
            const startMs = ms(b.windowStart);
            const endMs = ms(b.windowEnd);
            const spanSec =
              startMs != null && endMs != null
                ? Math.max(0, Math.round((endMs - startMs) / 1000))
                : null;
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
            return (
              <div
                key={b.id}
                className="card card-pad clickable"
                onClick={() => router.push(`/token/${b.mint}`)}
                style={
                  isNew
                    ? {
                        borderLeft: `3px solid ${CHART_COLORS.ACCENT}`,
                        animation: 'lf-fade-in 0.6s ease-out',
                      }
                    : undefined
                }
              >
                <div className="stack gap-10">
                  <div className="row gap-10" style={{ alignItems: 'center' }}>
                    <TokenMark
                      symbol={b.symbol || b.mint}
                      icon={b.icon ?? undefined}
                      icons={b.icons ?? undefined}
                      size={36}
                    />
                    <div className="stack" style={{ gap: 2 }}>
                      <div className="row gap-8">
                        <b style={{ fontSize: 13 }}>{symbol}</b>
                        {b.name && (
                          <span
                            className="faint"
                            style={{
                              fontSize: 11, maxWidth: 180, overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}
                          >
                            {b.name}
                          </span>
                        )}
                        <span className="faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                          {f.ago(endMs)}
                        </span>
                      </div>
                      <span className="mono faint" style={{ fontSize: 10.5 }}>
                        {f.short(b.mint, 4, 4)}
                      </span>
                    </div>
                  </div>

                  <div style={{ fontSize: 13.5, fontWeight: 600 }} className="row gap-8 wrap">
                    <span>
                      <span className="num pos" style={{ fontWeight: 700 }}>{b.buyers}</span>{' '}
                      smart wallets bought within {windowSec}s
                    </span>
                    {tierSummary && (
                      <span
                        className="mono"
                        style={{ fontWeight: 700, fontSize: 12, letterSpacing: '.02em', color: 'var(--text-2)' }}
                        title="Tiers of the sampled buyers (conviction at a glance)"
                      >
                        {tierSummary}
                      </span>
                    )}
                    {isTrap ? (
                      <span className="badge neg" title="Many wallets map to few entities — likely one actor faking a crowd">
                        TRAP · {b.buyerWallets} wallets / {b.buyers} entities
                      </span>
                    ) : (
                      b.buyerWallets > b.buyers && (
                        <span className="faint" style={{ fontWeight: 500, fontSize: 12 }}>
                          · {b.buyerWallets} wallets / {b.buyers} entities
                        </span>
                      )
                    )}
                  </div>

                  <div className="row gap-10 wrap faint" style={{ fontSize: 12 }}>
                    <span>
                      <span className="num">{f.sol(b.solTotal)}</span> SOL
                    </span>
                    {spanSec != null && <span>over {spanSec}s</span>}
                  </div>

                  {/* Live market context — render only fields that are present
                      (no fake zeros); '—' is shown for absent metrics inline. */}
                  {(mcap || liq || chg != null || lowLiq) && (
                    <div className="row gap-12 wrap" style={{ fontSize: 12 }}>
                      {mcap && (
                        <span className="faint">
                          MC <span className="num" style={{ color: 'var(--text)' }}>{mcap}</span>
                        </span>
                      )}
                      {liq && (
                        <span className="faint">
                          Liq <span className="num" style={{ color: 'var(--text)' }}>{liq}</span>
                        </span>
                      )}
                      {chg != null && Number.isFinite(chg) && (
                        <span className="faint">
                          24h{' '}
                          <span className={`num ${chg >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 650 }}>
                            {f.pct(chg)}
                          </span>
                        </span>
                      )}
                      {lowLiq && (
                        <span className="badge neg" title={`Liquidity under $${(LOW_LIQ_USD / 1000)}k — high rug risk`}>
                          low liq
                        </span>
                      )}
                    </div>
                  )}

                  {sample.length > 0 && (
                    <div className="row gap-10 wrap">
                      {sample.map((addr, i) => (
                        <span key={addr} className="row gap-8">
                          <AddrChip address={addr} />
                          {tiers[i] && <TierBadge tier={tiers[i]} />}
                        </span>
                      ))}
                    </div>
                  )}

                  <TradeLinks mint={b.mint} size="xs" primary />
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
