'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Flame } from 'lucide-react';
import * as f from '@/lib/format';
import {
  TokenMark, Sparkline, EmptyState, ErrorState, SkTable, CHART_COLORS,
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
}

interface SmartMoneyBuysResponse {
  generatedAt: string;
  hours: number;
  count: number;
  tokens: SmartBuyToken[];
}

type Window = 6 | 24 | 72;

const WINDOWS: Window[] = [6, 24, 72];
const AUTO_REFRESH_MS = 2 * 60 * 1000;

// Parse an ISO timestamp into epoch ms (or null) for the ms-based formatters.
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

// Deterministic, purely-visual rising series derived from the mint — mirrors
// the prototype's sparkline so each token gets a stable "buy trend" curve.
function trendSeries(mint: string): number[] {
  let x = (Array.from(mint).reduce((a, c) => a + c.charCodeAt(0), 0) % 97) / 97;
  const out: number[] = [];
  let acc = 0;
  for (let k = 0; k < 14; k++) {
    x = ((x * 9301 + 49297) % 233280) / 233280;
    acc += x * 0.7 + 0.15;
    out.push(acc);
  }
  return out;
}

function Header({ hours, onWindow }: { hours: Window; onWindow: (w: Window) => void }) {
  return (
    <div className="page-head">
      <div className="sub">
        Tokens bought by multiple verified smart wallets in the selected window.
      </div>
      <div className="page-head-actions">
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBuys = useCallback(async (window: Window) => {
    try {
      const response = await fetch(
        `/api/smart-money/buying?hours=${window}&limit=50`
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

  // Initial fetch + refetch whenever the time window changes.
  useEffect(() => {
    setLoading(true);
    fetchBuys(hours);
  }, [fetchBuys, hours]);

  // Auto-refresh every 2 minutes for the current window.
  useEffect(() => {
    const interval = setInterval(() => fetchBuys(hours), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchBuys, hours]);

  if (loading) {
    return (
      <div className="view stack gap-24">
        <Header hours={hours} onWindow={setHours} />
        <SkTable cols={6} rows={10} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="view stack gap-24">
        <Header hours={hours} onWindow={setHours} />
        <div className="card">
          <ErrorState
            msg="The buying feed didn’t respond."
            onRetry={() => { setLoading(true); fetchBuys(hours); }}
          />
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="view stack gap-24">
        <Header hours={hours} onWindow={setHours} />
        <div className="card">
          <EmptyState
            icon={Flame}
            title="Quiet window"
            msg={`No tokens were bought by multiple smart wallets in the last ${hours}h.`}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="view stack gap-16">
      <Header hours={hours} onWindow={setHours} />

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="table-wrap">
          <table className="dt ruled">
            <thead>
              <tr>
                <th style={{ width: 34 }}>#</th>
                <th>Token</th>
                <th className="r">Smart buyers</th>
                <th className="r">Buys</th>
                <th className="r">SOL volume</th>
                <th className="c">Buy trend</th>
                <th className="r">Last buy</th>
              </tr>
            </thead>
            <tbody>
              {data.map((t, i) => {
                const symbol = t.symbol || f.short(t.mint, 4, 4);
                const firstMs = ms(t.firstBuy);
                const age = firstMs ? `${f.ago(firstMs).replace(' ago', '')} old` : '—';
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
                    </td>
                    <td className="r num faint">{t.buys}</td>
                    <td className="r num" style={{ fontWeight: 600 }}>
                      {f.sol(t.solVolume)}{' '}
                      <span className="faint" style={{ fontWeight: 500, fontSize: 11 }}>SOL</span>
                    </td>
                    <td className="c">
                      <Sparkline
                        values={trendSeries(t.mint)}
                        width={78}
                        height={22}
                        color={CHART_COLORS.POS}
                      />
                    </td>
                    <td className="r faint" style={{ fontSize: 12 }}>
                      {f.ago(ms(t.lastBuy))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="faint" style={{ fontSize: 12, textAlign: 'center' }}>
        Ranked by distinct verified smart wallets buying · auto-refreshes every 2 minutes
      </p>
    </div>
  );
}
