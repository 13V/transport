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

// Parse an ISO timestamp into epoch ms (or null) for the ms-based formatters.
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
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
        <div className="seg">
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
        <div className="seg">
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
        <div className="seg">
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

  return (
    <div className="view stack gap-16">
      <Header hours={hours} onWindow={setHours} minBuyers={minBuyers} onMinBuyers={setMinBuyers} sort={sort} onSort={setSort} />

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="table-wrap">
          <table className="dt ruled">
            <thead>
              <tr>
                <th style={{ width: 34 }}>#</th>
                <th>Token</th>
                <th className="r">Smart buyers</th>
                <th className="r">Net flow</th>
                <th className="r">% since 1st buy</th>
                <th className="c">Buy momentum</th>
                <th className="r">Last buy</th>
                <th>Trade</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => {
                const symbol = t.symbol || f.short(t.mint, 4, 4);
                const firstMs = ms(t.firstBuy);
                const age = firstMs ? `${f.ago(firstMs).replace(' ago', '')} old` : '—';
                const net = t.netSolFlow;
                const sellers = t.sellers ?? 0;
                // "distribution": smart sellers outnumber buyers OR net flow is
                // negative — a sign the smart set is offloading, not accumulating.
                const distributing =
                  (net != null && net < 0) || sellers > t.distinctSmartBuyers;
                const momentum = Array.isArray(t.momentum) ? t.momentum : [];
                const roi = t.priceChangeSincePct;
                return (
                  <tr
                    key={t.mint}
                    className="clickable"
                    onClick={() => router.push(`/token/${t.mint}`)}
                  >
                    <td className={`rank ${i < 3 ? 'top' : ''}`}>{i + 1}</td>
                    <td>
                      <div className="row gap-10">
                        <TokenMark symbol={t.symbol || t.mint} icon={t.icon ?? undefined} icons={t.icons ?? undefined} size={36} />
                        <div className="stack" style={{ gap: 2 }}>
                          <div className="row gap-8">
                            <b style={{ fontSize: 13 }}>{symbol}</b>
                            {t.name && (
                              <span className="faint" style={{ fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {t.name}
                              </span>
                            )}
                            <span className="faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                              {age}
                            </span>
                          </div>
                          <span className="mono faint" style={{ fontSize: 10.5 }}>
                            {f.short(t.mint, 4, 4)}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="r">
                      <span className="num pos" style={{ fontWeight: 650, fontSize: 13 }}>
                        {t.distinctSmartBuyers}
                      </span>{' '}
                      <span className="faint" style={{ fontSize: 11 }}>smart</span>
                      {sellers > 0 && (
                        <div className="faint" style={{ fontSize: 10.5 }}>
                          {sellers} sold · {f.sol(t.solVolume)} buy
                        </div>
                      )}
                    </td>
                    <td className="r">
                      {net == null ? (
                        <span className="faint">—</span>
                      ) : (
                        <span className={`num ${net >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 600 }}>
                          {f.solSigned(net)}{' '}
                          <span className="faint" style={{ fontWeight: 500, fontSize: 11 }}>SOL</span>
                        </span>
                      )}
                      {distributing && (
                        <div className="num neg" style={{ fontSize: 10.5, fontWeight: 600 }}>
                          distribution
                        </div>
                      )}
                    </td>
                    <td className="r">
                      {roi == null || !Number.isFinite(roi) ? (
                        <span className="faint" title="No price reference yet">—</span>
                      ) : (
                        <span className={`num ${roi >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 650 }}>
                          {f.pct(roi, 1)}
                        </span>
                      )}
                    </td>
                    <td className="c">
                      {momentum.filter((v) => Number.isFinite(v)).length >= 2 ? (
                        <Sparkline
                          values={momentum}
                          width={78}
                          height={22}
                          color={CHART_COLORS.POS}
                        />
                      ) : (
                        <span className="faint" style={{ fontSize: 11 }}>—</span>
                      )}
                    </td>
                    <td className="r faint" style={{ fontSize: 12 }}>
                      {f.ago(ms(t.lastBuy))}
                    </td>
                    <td>
                      <TradeLinks mint={t.mint} size="xs" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="faint" style={{ fontSize: 12, textAlign: 'center' }}>
        Net flow = smart buys − smart sells · % since 1st buy from the first smart entry · auto-refreshes every 2 minutes
      </p>
    </div>
  );
}
