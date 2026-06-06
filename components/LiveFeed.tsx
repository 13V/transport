'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Radio } from 'lucide-react';
import * as f from '@/lib/format';
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
}

interface LiveResponse {
  generatedAt: string;
  windowSec: number;
  minBuyers: number;
  count: number;
  bursts: Burst[];
}

const MIN_BUYERS: number[] = [3, 4, 5];
const WINDOW_SEC: number[] = [15, 30, 60];
const POLL_MS = 7 * 1000;

// Parse an ISO timestamp into epoch ms (or null) for the ms-based formatters.
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function Header({
  minBuyers, onMinBuyers, windowSec, onWindowSec,
}: {
  minBuyers: number;
  onMinBuyers: (n: number) => void;
  windowSec: number;
  onWindowSec: (n: number) => void;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track seen burst ids so we only highlight genuinely new cards on later polls.
  const seenRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);
  const mountedRef = useRef(true);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  // Re-rendered "now" tick so relative ages stay fresh between polls.
  const [, setTick] = useState(0);

  const fetchLive = useCallback(async (min: number, win: number) => {
    try {
      const res = await fetch(
        `/api/smart-money/live?windowSec=${win}&minBuyers=${min}&hours=6&limit=50`
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
    fetchLive(minBuyers, windowSec);
    return () => { mountedRef.current = false; };
  }, [fetchLive, minBuyers, windowSec]);

  // Poll every 7s for the current controls (data updates in near real-time).
  useEffect(() => {
    const interval = setInterval(() => fetchLive(minBuyers, windowSec), POLL_MS);
    return () => clearInterval(interval);
  }, [fetchLive, minBuyers, windowSec]);

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
        />
        <div className="card">
          <ErrorState
            msg="The live feed didn’t respond."
            onRetry={() => { setLoading(true); fetchLive(minBuyers, windowSec); }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="view stack gap-16">
      <Header
        minBuyers={minBuyers} onMinBuyers={setMinBuyers}
        windowSec={windowSec} onWindowSec={setWindowSec}
      />

      <div className="card card-pad">
        <div className="row gap-10" style={{ alignItems: 'center' }}>
          <span
            aria-hidden
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: CHART_COLORS.POS,
              boxShadow: `0 0 0 3px ${CHART_COLORS.POS}33`,
              flexShrink: 0,
            }}
          />
          <span className="faint" style={{ fontSize: 12 }}>
            Updated {f.ago(ms(generatedAt))} · auto-refreshes every 7s
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

                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                    <span className="num pos" style={{ fontWeight: 700 }}>{b.buyers}</span>{' '}
                    smart wallets bought within {windowSec}s
                    {b.buyerWallets > b.buyers && (
                      <span className="faint" style={{ fontWeight: 500, fontSize: 12 }}>
                        {' '}· {b.buyerWallets} wallets / {b.buyers} entities
                      </span>
                    )}
                  </div>

                  <div className="row gap-10 wrap faint" style={{ fontSize: 12 }}>
                    <span>
                      <span className="num">{f.sol(b.solTotal)}</span> SOL
                    </span>
                    {spanSec != null && <span>over {spanSec}s</span>}
                  </div>

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

                  <TradeLinks mint={b.mint} size="xs" />
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
