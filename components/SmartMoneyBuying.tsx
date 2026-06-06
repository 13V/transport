'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Flame } from 'lucide-react';
import * as f from '@/lib/format';
import {
  TokenMark, Sparkline, EmptyState, ErrorState, SkTable, TradeLinks, CHART_COLORS,
} from '@/components/ui';

interface SmartBuyToken {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  icon?: string | null;
  icons?: string[] | null;
  distinctSmartBuyers: number;
  buys: number;
  solVolume: number;
  firstBuy: string | null;
  lastBuy: string | null;
  sampleBuyers: string[];
  momentum?: number[] | null;
  sellers?: number;
  solSold?: number;
  netSolFlow?: number;
  firstBuyPriceSol?: number | null;
  priceChangeSincePct?: number | null;
  // Live market context (enriched server-side; optional so tsc stays clean and
  // we only render fields that are present — never fake data).
  mintRenounced?: boolean | null;
  freezeRenounced?: boolean | null;
  pairCreatedAt?: number | null;
  buys24h?: number | null;
  sells24h?: number | null;
  volume24hUsd?: number | null;
  topHolderPct?: number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  priceChange24h?: number | null;
  pairAddress?: string | null;
}

interface SmartMoneyBuysResponse {
  generatedAt: string;
  hours: number;
  count: number;
  tokens: SmartBuyToken[];
}

type Window = 6 | 24 | 72;
type Sort = 'buyers' | 'volume' | 'recency';

const WINDOWS: Window[] = [6, 24, 72];
const SORTS: { key: Sort; label: string }[] = [
  { key: 'buyers', label: 'Buyers' },
  { key: 'volume', label: 'SOL vol' },
  { key: 'recency', label: 'Recent' },
];
const MIN_BUYERS: number[] = [1, 2, 3, 5];
const AUTO_REFRESH_MS = 2 * 60 * 1000;

// liq/MC ratio below this → "THIN LIQ" chip (matches the Live page).
const THIN_LIQ_RATIO = 0.02;
// Token age under this (ms) tints the age chip red — very new = higher rug risk.
const VERY_NEW_MS = 10 * 60 * 1000;
// Top-holder concentration above this → whale-risk amber chip.
const WHALE_PCT = 25;

// localStorage key for the per-user default trade terminal — the SAME key the
// Live page uses so a device's execution pref rides across both feeds.
const PREF_TERMINAL_KEY = 'sm_pref_terminal';
// Terminals the user may have promoted (must match labels in lib/trade-links.ts).
const TERMINALS = ['Axiom', 'GMGN', 'BullX', 'Photon', 'Jupiter'] as const;

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

// Compact USD: "$1.2M" / "$340k" / "$820". Returns null when absent.
function usdCompact(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `$${f.compact(n)}`;
}

// Read the default terminal pref from localStorage (same key as the Live page).
function readPrefTerminal(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const t = window.localStorage.getItem(PREF_TERMINAL_KEY);
    return t && TERMINALS.includes(t as (typeof TERMINALS)[number]) ? t : null;
  } catch {
    return null;
  }
}

function Header({
  hours, onWindow, minBuyers, onMinBuyers, sort, onSort,
}: {
  hours: Window;
  onWindow: (w: Window) => void;
  minBuyers: number;
  onMinBuyers: (n: number) => void;
  sort: Sort;
  onSort: (s: Sort) => void;
}) {
  return (
    <div className="page-head">
      <div className="sub">
        Tokens bought by multiple verified smart wallets in the selected window.
      </div>
      <div className="page-head-actions row gap-10 wrap">
        <div className="seg" title="Minimum distinct smart buyers per token">
          {MIN_BUYERS.map((n) => (
            <button
              key={n}
              type="button"
              className={minBuyers === n ? 'on' : ''}
              onClick={() => onMinBuyers(n)}
              aria-pressed={minBuyers === n}
              title={`Only tokens with at least ${n} distinct smart buyer${n > 1 ? 's' : ''}`}
            >
              ≥{n}
            </button>
          ))}
        </div>
        <div className="seg" title="Order tokens by buyers, SOL volume or recency">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={sort === s.key ? 'on' : ''}
              onClick={() => onSort(s.key)}
              aria-pressed={sort === s.key}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="seg" title="Look-back window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={hours === w ? 'on' : ''}
              onClick={() => onWindow(w)}
              aria-pressed={hours === w}
            >
              {w}h
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SmartMoneyBuying() {
  const router = useRouter();
  const [data, setData] = useState<SmartBuyToken[]>([]);
  const [hours, setHours] = useState<Window>(24);
  const [minBuyers, setMinBuyers] = useState<number>(1);
  const [sort, setSort] = useState<Sort>('buyers');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Default trade terminal (same localStorage pref the Live page writes).
  const [prefTerminal, setPrefTerminal] = useState<string | null>(null);

  // Hydrate the terminal pref once on mount (avoids SSR/localStorage mismatch).
  useEffect(() => {
    setPrefTerminal(readPrefTerminal());
  }, []);

  const fetchBuys = useCallback(async (window: Window, min: number) => {
    try {
      const response = await fetch(
        `/api/smart-money/buying?hours=${window}&limit=50&minBuyers=${min}`
      );
      if (!response.ok) throw new Error('Failed to fetch smart money buys');

      const json = (await response.json()) as SmartMoneyBuysResponse;
      setData(json.tokens ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load smart money buys');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + refetch whenever window or the buyers floor changes.
  useEffect(() => {
    setLoading(true);
    fetchBuys(hours, minBuyers);
  }, [fetchBuys, hours, minBuyers]);

  // Auto-refresh every 2 minutes for the current window/filter.
  useEffect(() => {
    const interval = setInterval(() => fetchBuys(hours, minBuyers), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchBuys, hours, minBuyers]);

  // Sort over the returned rows (client-side; no refetch needed).
  const rows = useMemo(() => {
    const copy = data.slice();
    copy.sort((a, b) => {
      if (sort === 'volume') return b.solVolume - a.solVolume;
      if (sort === 'recency') return (ms(b.lastBuy) ?? 0) - (ms(a.lastBuy) ?? 0);
      return b.distinctSmartBuyers - a.distinctSmartBuyers || b.solVolume - a.solVolume;
    });
    return copy;
  }, [data, sort]);

  if (loading) {
    return (
      <div className="view stack gap-24">
        <Header hours={hours} onWindow={setHours} minBuyers={minBuyers} onMinBuyers={setMinBuyers} sort={sort} onSort={setSort} />
        <SkTable cols={8} rows={10} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="view stack gap-24">
        <Header hours={hours} onWindow={setHours} minBuyers={minBuyers} onMinBuyers={setMinBuyers} sort={sort} onSort={setSort} />
        <div className="card">
          <ErrorState
            msg="The buying feed didn’t respond."
            onRetry={() => { setLoading(true); fetchBuys(hours, minBuyers); }}
          />
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="view stack gap-24">
        <Header hours={hours} onWindow={setHours} minBuyers={minBuyers} onMinBuyers={setMinBuyers} sort={sort} onSort={setSort} />
        <div className="card">
          <EmptyState
            icon={Flame}
            title="Quiet window"
            msg={
              minBuyers > 1
                ? `No tokens had ≥${minBuyers} smart wallets buying in the last ${hours}h.`
                : `No tokens were bought by multiple smart wallets in the last ${hours}h.`
            }
          />
        </div>
      </div>
    );
  }

  // Render one token as a dense terminal row (mirrors the Live feed aesthetic).
  const renderRow = (t: SmartBuyToken, i: number): React.ReactNode => {
    const now = Date.now();
    const symbol = t.symbol || f.short(t.mint, 4, 4);
    const firstMs = ms(t.firstBuy);
    const ageLabel = firstMs ? `${f.ago(firstMs).replace(' ago', '')} old` : null;
    const net = t.netSolFlow;
    const sellers = t.sellers ?? 0;
    // "distribution": smart sellers outnumber buyers OR net flow is negative —
    // a sign the smart set is offloading, not accumulating.
    const distributing = (net != null && net < 0) || sellers > t.distinctSmartBuyers;
    const momentum = Array.isArray(t.momentum) ? t.momentum : [];
    const hasSpark = momentum.filter((v) => Number.isFinite(v)).length >= 2;
    const roi = t.priceChangeSincePct;

    // --- Market strip (render only present fields) ---
    const mcap = usdCompact(t.marketCapUsd);
    const liq = usdCompact(t.liquidityUsd);
    const vol = usdCompact(t.volume24hUsd);
    const chg = t.priceChange24h;
    const tier = mcapTier(t.marketCapUsd);

    // --- Rug / safety chips (identical semantics to the Live page) ---
    const mintLive = t.mintRenounced === false;
    const freezeLive = t.freezeRenounced === false;
    const bothSafe = t.mintRenounced === true && t.freezeRenounced === true;
    const noSells = t.sells24h === 0 && (t.buys24h ?? 0) > 5;
    const liqMcRatio =
      t.liquidityUsd != null && t.marketCapUsd != null && t.marketCapUsd > 0
        ? t.liquidityUsd / t.marketCapUsd
        : null;
    const thinLiq = liqMcRatio != null && liqMcRatio < THIN_LIQ_RATIO;
    const whale =
      t.topHolderPct != null && Number.isFinite(t.topHolderPct) && t.topHolderPct > WHALE_PCT;
    const createdMs =
      t.pairCreatedAt != null && Number.isFinite(t.pairCreatedAt) ? t.pairCreatedAt : null;
    const pairAge = createdMs != null ? ageShort(createdMs, now) : null;
    const veryNew = createdMs != null && now - createdMs < VERY_NEW_MS;
    const hasSafetyRow =
      mintLive || freezeLive || bothSafe || pairAge || noSells || thinLiq || whale;
    const hasMarketRow =
      mcap || liq || vol || (chg != null && Number.isFinite(chg));

    return (
      <div
        key={t.mint}
        id={`bf-${t.mint}`}
        className="bf-row"
        onClick={() => router.push(`/token/${t.mint}`)}
      >
        <div className="stack gap-10" style={{ minWidth: 0 }}>
          {/* Identity line: rank + avatar + ticker/name + mint + age */}
          <div className="bf-id">
            <span className={`rank ${i < 3 ? 'top' : ''}`} style={{ flexShrink: 0 }}>{i + 1}</span>
            <TokenMark
              symbol={t.symbol || t.mint}
              icon={t.icon ?? undefined}
              icons={t.icons ?? undefined}
              size={34}
            />
            <div className="bf-id-text">
              <div className="bf-ticker-line">
                <span className="bf-ticker">{symbol}</span>
                {t.name && <span className="bf-name">{t.name}</span>}
              </div>
              <div className="bf-meta-line">
                <span className="bf-mint mono">{f.short(t.mint, 4, 4)}</span>
                {ageLabel && <span className="bf-age">· {ageLabel}</span>}
                <span className="bf-age">· {f.ago(ms(t.lastBuy))}</span>
              </div>
            </div>
            {/* Buy-momentum sparkline */}
            {hasSpark && (
              <div className="bf-spark" title="Smart-buy momentum across the window (per-hour buys)">
                <Sparkline values={momentum} width={84} height={26} color={CHART_COLORS.POS} />
              </div>
            )}
          </div>

          {/* Hero: distinct smart buyers + net flow + % since first buy */}
          <div className="bf-hero">
            <span className="bf-sol">
              {t.distinctSmartBuyers}
              <span className="unit">smart {t.distinctSmartBuyers === 1 ? 'buyer' : 'buyers'}</span>
            </span>
            {net != null && (
              <span className="bf-wallets" title="Net SOL flow = smart buys − smart sells">
                net{' '}
                <b style={{ color: net >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                  {f.solSigned(net)}
                </b>{' '}
                SOL
              </span>
            )}
            {roi != null && Number.isFinite(roi) && (
              <span
                className={`bf-since ${roi >= 0 ? 'pos' : 'neg'}`}
                title="Price change since the first smart buy — still early or gone?"
              >
                {roi >= 0 ? '▲' : '▼'} {f.pct(roi, 1)} since 1st buy
              </span>
            )}
          </div>

          {/* Rug / safety chips (only when present) */}
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
              {pairAge && (
                <span
                  className={`bf-chip${veryNew ? ' danger' : ' neutral'}`}
                  title={veryNew ? 'Very new token — elevated rug risk' : 'Token age'}
                >
                  ⏳ {pairAge} old
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
              {whale && (
                <span className="bf-chip warn" title="Top holder controls a large share of supply">
                  WHALE {Math.round(t.topHolderPct!)}%
                </span>
              )}
            </div>
          )}

          {/* Distribution warning + seller context */}
          {(distributing || sellers > 0) && (
            <div className="bf-sub">
              {distributing && (
                <span className="bf-trap" title="Smart sellers outnumber buyers or net flow is negative — smart money is offloading">
                  DISTRIBUTION
                </span>
              )}
              {sellers > 0 && (
                <span title="Distinct smart wallets that sold in the window">
                  {sellers} sold · {f.sol(t.solVolume)}◎ bought
                </span>
              )}
            </div>
          )}

          {/* Market strip: MC / Liq / 24h% / Vol24h (only when present) */}
          {hasMarketRow && (
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
              {chg != null && Number.isFinite(chg) && (
                <div className="bf-metric">
                  <span className="k">24h</span>
                  <span className={`v ${chg >= 0 ? 'pos' : 'neg'}`}>{f.pct(chg)}</span>
                </div>
              )}
              {vol && (
                <div className="bf-metric">
                  <span className="k">Vol 24h</span>
                  <span className="v">{vol}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right column: one-tap Ape */}
        <div className="bf-right">
          <div className="bf-actions">
            <TradeLinks
              mint={t.mint}
              size="xs"
              primary
              preferred={prefTerminal ?? undefined}
              pairAddress={t.pairAddress ?? undefined}
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="view stack gap-16">
      <Header hours={hours} onWindow={setHours} minBuyers={minBuyers} onMinBuyers={setMinBuyers} sort={sort} onSort={setSort} />

      <div className="bf-list stack gap-8">
        {rows.map((t, i) => renderRow(t, i))}
      </div>

      <p className="faint" style={{ fontSize: 12, textAlign: 'center' }}>
        Net flow = smart buys − smart sells · % since 1st buy from the first smart entry · auto-refreshes every 2 minutes
      </p>
    </div>
  );
}
