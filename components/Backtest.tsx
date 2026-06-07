'use client';

/* =========================================================================
   SIGNAL BACKTESTER — "historically, how did smart-money bursts matching THESE
   criteria perform?" A quant tool over the MEASURED outcome table: the user
   dials in a quality bar (≥ buyers, ≥ SOL, S/A-tier counts, multi-entity, side,
   lookback) and we answer from real forward returns — median / hit-rate @1h &
   @24h, n, best/worst call, a return histogram, and a by-buyer-count breakdown.

   NO FABRICATION: numbers come straight from /api/smart-money/backtest, which
   only aggregates real ret_* legs. Missing legs render as '—'; no matches yields
   an honest empty state.
   ========================================================================= */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { FlaskConical } from 'lucide-react';
import * as f from '@/lib/format';

interface DistBucket { bucket: string; count: number; }
interface ByBuyerCount { buyers: number; n: number; medianRet1h: number | null; }
interface BacktestCall {
  symbol: string | null;
  mint: string;
  ret: number;
  horizon: '15m' | '1h' | '24h';
}
interface BacktestResult {
  n: number;
  medianRet15m: number | null;
  hitRate15m: number | null;
  avgRet15m: number | null;
  medianRet1h: number | null;
  hitRate1h: number | null;
  avgRet1h: number | null;
  medianRet24h: number | null;
  hitRate24h: number | null;
  avgRet24h: number | null;
  measured: number;
  bestCall: BacktestCall | null;
  worstCall: BacktestCall | null;
  distribution: DistBucket[];
  byBuyerCount: ByBuyerCount[];
}

const MIN_BUYERS: number[] = [0, 3, 4, 5, 8];
const MIN_SOL: number[] = [0, 1, 5, 10, 25];
const MIN_TIER: number[] = [0, 1, 2, 3];
const WINDOW_DAYS: number[] = [7, 30, 90, 365];

// Color a return value via the existing pos/neg classes (null → muted).
function retClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'bt-muted';
  return v >= 0 ? 'pos' : 'neg';
}

function pctOrDash(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : f.pct(v);
}

function buildQuery(s: {
  minBuyers: number; minSol: number; minSTier: number; minATier: number;
  multiEntity: boolean; side: 'any' | 'buy' | 'sell'; windowDays: number;
}): string {
  const q = new URLSearchParams();
  if (s.minBuyers > 0) q.set('minBuyers', String(s.minBuyers));
  if (s.minSol > 0) q.set('minSol', String(s.minSol));
  if (s.minSTier > 0) q.set('minSTier', String(s.minSTier));
  if (s.minATier > 0) q.set('minATier', String(s.minATier));
  if (s.multiEntity) q.set('multiEntity', '1');
  if (s.side !== 'any') q.set('side', s.side);
  q.set('windowDays', String(s.windowDays));
  return q.toString();
}

/** Big headline stat block for one horizon (median + hit-rate, color-coded). */
function Headline({
  label, median, hitRate, n,
}: {
  label: string;
  median: number | null;
  hitRate: number | null;
  n: number | null;
}) {
  return (
    <div className="bt-headline">
      <div className="bt-headline-h">median return @{label}</div>
      <div className={`bt-headline-v ${retClass(median)}`}>{pctOrDash(median)}</div>
      <div className="bt-headline-sub">
        {hitRate == null || !Number.isFinite(hitRate) ? (
          <span className="bt-muted">no measured legs</span>
        ) : (
          <>
            <b className={hitRate >= 50 ? 'pos' : 'neg'}>{Math.round(hitRate)}%</b> closed green
            {n != null && <span className="bt-muted"> · n={n}</span>}
          </>
        )}
      </div>
    </div>
  );
}

/** A linked notable call (best / worst). */
function CallRow({ label, call, tone }: { label: string; call: BacktestCall | null; tone: 'pos' | 'neg'; }) {
  if (!call) return null;
  const sym = call.symbol || f.short(call.mint, 4, 4);
  return (
    <Link href={`/token/${call.mint}`} className="bt-call">
      <span className="bt-call-label">{label}</span>
      <span className="bt-call-sym">{sym}</span>
      <span className={`bt-call-ret ${tone}`}>
        {call.ret >= 0 ? '+' : ''}{f.pct(call.ret)}
      </span>
      <span className="bt-call-h bt-muted">@{call.horizon}</span>
    </Link>
  );
}

/** Return-distribution histogram (1h leg), real counts → relative bars. */
function Distribution({ dist }: { dist: DistBucket[] }) {
  const max = Math.max(1, ...dist.map((d) => d.count));
  const total = dist.reduce((a, d) => a + d.count, 0);
  if (total === 0) {
    return <div className="bt-empty-inline">No measured 1h returns in this set yet.</div>;
  }
  return (
    <div className="bt-dist" role="img" aria-label="Distribution of 1h returns">
      {dist.map((d) => {
        // Bucket sign drives the bar color: anything starting below 0 is a loss.
        const negative = d.bucket.startsWith('<') || d.bucket.startsWith('-');
        const h = `${Math.round((d.count / max) * 100)}%`;
        return (
          <div key={d.bucket} className="bt-dist-col" title={`${d.bucket}: ${d.count}`}>
            <div className="bt-dist-bar-wrap">
              <div
                className={`bt-dist-bar ${negative ? 'neg' : 'pos'}`}
                style={{ height: d.count > 0 ? h : '2px' }}
              />
            </div>
            <div className="bt-dist-count">{d.count || ''}</div>
            <div className="bt-dist-label">{d.bucket}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function Backtest() {
  const [minBuyers, setMinBuyers] = useState(3);
  const [minSol, setMinSol] = useState(0);
  const [minSTier, setMinSTier] = useState(0);
  const [minATier, setMinATier] = useState(0);
  const [multiEntity, setMultiEntity] = useState(false);
  const [side, setSide] = useState<'any' | 'buy' | 'sell'>('any');
  const [windowDays, setWindowDays] = useState(30);

  const [data, setData] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const query = useMemo(
    () => buildQuery({ minBuyers, minSol, minSTier, minATier, multiEntity, side, windowDays }),
    [minBuyers, minSol, minSTier, minATier, multiEntity, side, windowDays]
  );

  const run = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/smart-money/backtest?${q}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const json = (await res.json()) as BacktestResult;
      if (!mountedRef.current) return;
      setData(json);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to run backtest');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Re-run whenever the filters change. Debounced so rapid toggling (or holding
  // down a segment) collapses into a single request instead of a storm — the
  // first paint runs immediately, later filter changes wait out the debounce.
  const firstRunRef = useRef(true);
  useEffect(() => {
    const delay = firstRunRef.current ? 0 : 300;
    firstRunRef.current = false;
    const t = setTimeout(() => run(query), delay);
    return () => clearTimeout(t);
  }, [query, run]);

  const hasMatches = !!data && data.n > 0;
  const hasOutcomes = !!data && data.measured > 0;

  return (
    <div className="view bt-view stack gap-24">
      <div className="page-head">
        <div className="sub">
          Signal backtester — pick a quality bar and see how smart-money bursts that
          cleared it actually performed, measured from real forward returns. Every
          number is a measured outcome; legs still accruing show as “—”.
        </div>
      </div>

      {/* FILTER CONTROLS */}
      <div className="card card-pad bt-controls">
        <div className="bt-ctrl">
          <span className="bt-ctrl-label">Min buyers</span>
          <div className="seg" title="Minimum distinct smart-money entities in the burst">
            {MIN_BUYERS.map((v) => (
              <button key={v} type="button" className={minBuyers === v ? 'on' : ''}
                onClick={() => setMinBuyers(v)} aria-pressed={minBuyers === v}>
                {v === 0 ? 'Any' : `≥${v}`}
              </button>
            ))}
          </div>
        </div>

        <div className="bt-ctrl">
          <span className="bt-ctrl-label">Min SOL</span>
          <div className="seg" title="Minimum total SOL committed across the burst">
            {MIN_SOL.map((v) => (
              <button key={v} type="button" className={minSol === v ? 'on' : ''}
                onClick={() => setMinSol(v)} aria-pressed={minSol === v}>
                {v === 0 ? 'Any' : `≥${v}◎`}
              </button>
            ))}
          </div>
        </div>

        <div className="bt-ctrl">
          <span className="bt-ctrl-label">S-tier wallets</span>
          <div className="seg" title="Minimum count of S-tier wallets in the burst">
            {MIN_TIER.map((v) => (
              <button key={v} type="button" className={minSTier === v ? 'on' : ''}
                onClick={() => setMinSTier(v)} aria-pressed={minSTier === v}>
                {v === 0 ? 'Any' : `≥${v}`}
              </button>
            ))}
          </div>
        </div>

        <div className="bt-ctrl">
          <span className="bt-ctrl-label">A-tier wallets</span>
          <div className="seg" title="Minimum count of A-tier wallets in the burst">
            {MIN_TIER.map((v) => (
              <button key={v} type="button" className={minATier === v ? 'on' : ''}
                onClick={() => setMinATier(v)} aria-pressed={minATier === v}>
                {v === 0 ? 'Any' : `≥${v}`}
              </button>
            ))}
          </div>
        </div>

        <div className="bt-ctrl">
          <span className="bt-ctrl-label">Side</span>
          <div className="seg" title="Trade side">
            {(['any', 'buy', 'sell'] as const).map((v) => (
              <button key={v} type="button" className={side === v ? 'on' : ''}
                onClick={() => setSide(v)} aria-pressed={side === v}>
                {v === 'any' ? 'Any' : v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="bt-ctrl">
          <span className="bt-ctrl-label">Lookback</span>
          <div className="seg" title="How far back to look (by burst close time)">
            {WINDOW_DAYS.map((v) => (
              <button key={v} type="button" className={windowDays === v ? 'on' : ''}
                onClick={() => setWindowDays(v)} aria-pressed={windowDays === v}>
                {v >= 365 ? '1y' : `${v}d`}
              </button>
            ))}
          </div>
        </div>

        <div className="bt-ctrl">
          <span className="bt-ctrl-label">Independent crowd</span>
          <button
            type="button"
            className={`seg-btn${multiEntity ? ' on' : ''}`}
            onClick={() => setMultiEntity((x) => !x)}
            aria-pressed={multiEntity}
            title="Only multi-entity bursts (distinct wallets, not one wallet fanning out)"
            style={{ whiteSpace: 'nowrap' }}
          >
            {multiEntity ? '✓ Multi-entity only' : 'Multi-entity only'}
          </button>
        </div>
      </div>

      {/* RESULTS */}
      {error ? (
        <div className="card card-pad">
          <div className="placeholder">
            <div className="ph-ic"><FlaskConical size={22} /></div>
            <h4>Backtest didn’t respond</h4>
            <p>{error}</p>
            <button className="btn primary sm" type="button" onClick={() => run(query)}>Retry</button>
          </div>
        </div>
      ) : loading && !data ? (
        // First-load skeleton reserves the FULL results layout (headlines +
        // distribution + table) so the page never shifts when real data lands.
        <>
          <div className="card card-pad bt-results">
            <div className="sk sk-line" style={{ width: '40%', height: 16, marginBottom: 16 }} />
            <div className="bt-headlines">
              <div className="sk" style={{ height: 96 }} />
              <div className="sk" style={{ height: 96 }} />
              <div className="sk" style={{ height: 96 }} />
            </div>
          </div>
          <div className="card card-pad">
            <div className="sk sk-line" style={{ width: '30%', height: 16, marginBottom: 12 }} />
            <div className="sk" style={{ height: 140 }} />
          </div>
          <div className="card card-pad">
            <div className="sk sk-line" style={{ width: '30%', height: 16, marginBottom: 12 }} />
            <div className="sk" style={{ height: 120 }} />
          </div>
        </>
      ) : !hasMatches ? (
        <div className="card card-pad">
          <div className="placeholder">
            <div className="ph-ic"><FlaskConical size={22} /></div>
            <h4>No measured bursts match yet</h4>
            <p>Outcomes accrue as the tracker runs. Loosen the filters or widen the lookback.</p>
          </div>
        </div>
      ) : (
        <>
          {/* HEADLINE STATS */}
          <div className="card card-pad bt-results">
            <div className="bt-results-head">
              <span className="bt-tag">
                <FlaskConical size={14} /> measured outcomes
                {loading && <span className="bt-muted" style={{ marginLeft: 6, fontWeight: 400 }}>updating…</span>}
              </span>
              <span className="bt-meta bt-muted">
                {data!.n} matching {data!.n === 1 ? 'burst' : 'bursts'} · {data!.measured} with measured outcomes · last {windowDays >= 365 ? '1y' : `${windowDays}d`}
              </span>
            </div>

            {!hasOutcomes ? (
              <div className="bt-empty-inline">
                {data!.n} {data!.n === 1 ? 'burst matches' : 'bursts match'}, but none have a measured
                forward return yet — outcomes accrue as the tracker runs.
              </div>
            ) : (
              <>
                <div className="bt-headlines">
                  <Headline label="15m" median={data!.medianRet15m} hitRate={data!.hitRate15m} n={null} />
                  <Headline label="1h" median={data!.medianRet1h} hitRate={data!.hitRate1h} n={null} />
                  <Headline label="24h" median={data!.medianRet24h} hitRate={data!.hitRate24h} n={null} />
                </div>

                {/* secondary: average returns */}
                <div className="bt-avgrow">
                  <span>avg @15m <b className={retClass(data!.avgRet15m)}>{pctOrDash(data!.avgRet15m)}</b></span>
                  <span>avg @1h <b className={retClass(data!.avgRet1h)}>{pctOrDash(data!.avgRet1h)}</b></span>
                  <span>avg @24h <b className={retClass(data!.avgRet24h)}>{pctOrDash(data!.avgRet24h)}</b></span>
                </div>

                {/* best / worst */}
                {(data!.bestCall || data!.worstCall) && (
                  <div className="bt-calls">
                    <CallRow label="Best call" call={data!.bestCall} tone="pos" />
                    <CallRow label="Worst call" call={data!.worstCall} tone="neg" />
                  </div>
                )}
              </>
            )}
          </div>

          {/* DISTRIBUTION */}
          <div className="card card-pad">
            <div className="card-head"><h3>Return distribution <span className="bt-muted">@1h</span></h3></div>
            <Distribution dist={data!.distribution} />
          </div>

          {/* BY BUYER COUNT */}
          <div className="card card-pad">
            <div className="card-head"><h3>By buyer count <span className="bt-muted">median @1h</span></h3></div>
            {data!.byBuyerCount.length === 0 ? (
              <div className="bt-empty-inline">No buyer-count breakdown available yet.</div>
            ) : (
              <table className="bt-table">
                <thead>
                  <tr><th>Smart buyers</th><th>Bursts</th><th>Median @1h</th></tr>
                </thead>
                <tbody>
                  {data!.byBuyerCount.map((r) => (
                    <tr key={r.buyers}>
                      <td className="mono">{r.buyers}</td>
                      <td className="mono">{r.n}</td>
                      <td className={`mono ${retClass(r.medianRet1h)}`}>{pctOrDash(r.medianRet1h)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
