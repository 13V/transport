'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Users, Wallet, TrendingUp, Globe, Twitter, Send, MessageCircle, ExternalLink, LineChart, Activity } from 'lucide-react';
import * as f from '@/lib/format';
import {
  TokenMark, TierBadge, Roi, Pnl, AddrChip, CopyIconButton,
  EmptyState, ErrorState, SkCard, SkStat, SkTable,
  AreaChart, CHART_COLORS,
} from '@/components/ui';

// Client-side icon candidates for a mint (no extra API call). TokenImg walks
// these and falls back to the letter avatar if they 404.
function iconFor(mint: string): string[] {
  return [`https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png`];
}

interface SmartHolder {
  wallet: string;
  tier: string | null;
  allTimeRoiPct: number | null;
  verified: boolean;
  solBought: number;
  avgCostSol: number;
  pnlOnThisCoin: number;
  unrealizedSol: number;
  currentValueSol: number;
  tokensRemaining: number;
  buys: number;
  sells: number;
  lastBuy: string | null;
}

// Per-coin trader (unverified) returned by /api/token/{mint}/traders.
interface TokenTrader {
  wallet: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  roi: number;
  solSpent: number;
  buys: number;
  sells: number;
  tokensRemaining: number;
  lastTradeAt: string | null;
}

interface TokenLink { kind: string; url: string }
interface TokenInfo {
  symbol?: string;
  name?: string;
  icon?: string;
  icons?: string[];
  links?: TokenLink[];
  description?: string;
  pairAddress?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange24h?: number;
}

function LinkIcon({ kind }: { kind: string }) {
  const k = kind.toLowerCase();
  if (k.includes('twitter') || k === 'x') return <Twitter size={14} />;
  if (k.includes('telegram')) return <Send size={14} />;
  if (k.includes('discord')) return <MessageCircle size={14} />;
  if (k.includes('web') || k.includes('site')) return <Globe size={14} />;
  return <ExternalLink size={14} />;
}

interface SmartHoldersResponse {
  mint: string;
  token?: TokenInfo;
  priceSol?: number;
  traderCount: number;
  smartHolderCount: number;
  smartHolders: SmartHolder[];
  netFlowSeries?: number[];
}

// Render a sub-$1 price without exponential notation. For tiny values we use
// the "subscript zeros" convention common on DEX UIs (e.g. $0.0₈123 means
// 0.0 followed by 8 zeros then 123), so pump tokens at 1.23e-8 read cleanly.
const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';
function subscript(n: number): string {
  return String(n).split('').map((d) => SUBSCRIPTS[+d]).join('');
}
function smallUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a === 0) return '$0.00';
  if (a >= 0.01) return `${sign}$${a.toFixed(a >= 0.1 ? 3 : 4)}`;
  // Count the leading zeros after the decimal point (epsilon guards FP edges
  // on exact powers of ten, e.g. 0.001 → log10 of -2.9999…).
  const zeros = Math.max(0, -Math.floor(Math.log10(a) + 1e-12) - 1);
  // Up to ~4 significant digits, stripped of trailing zeros.
  const sig = (a * Math.pow(10, zeros + 4)).toFixed(0).replace(/0+$/, '') || '0';
  if (zeros <= 3) return `${sign}$0.${'0'.repeat(zeros)}${sig}`;
  return `${sign}$0.0${subscript(zeros)}${sig}`;
}

// Compact USD formatter for live market stats.
function usd(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${n.toFixed(2)}`;
  return smallUsd(n);
}

interface TokenSmartHoldersProps {
  mint: string;
}

// Derive a position label from buy/sell activity on this coin.
function positionFor(h: SmartHolder): { label: string; cls: string } {
  if (h.tokensRemaining <= 0) return { label: 'Exited', cls: 'neg' };
  if (h.buys > h.sells) return { label: 'Adding', cls: 'pos' };
  if (h.sells > h.buys) return { label: 'Trimming', cls: 'neg' };
  return { label: 'Holding', cls: '' };
}

// Fallback when no VERIFIED smart wallets hold the coin: show the per-coin
// winners from the live Helius scan, clearly labelled as unverified.
function TopTradersFallback({ mint }: { mint: string }) {
  const router = useRouter();
  const [traders, setTraders] = useState<TokenTrader[] | null>(null);
  const [state, setState] = useState<'loading' | 'error' | 'done'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState('loading');
      try {
        const res = await fetch(`/api/token/${mint}/traders?winners=1&limit=25&sort=total`);
        if (!res.ok) throw new Error('failed');
        const json = await res.json();
        if (!cancelled) {
          setTraders((json.traders as TokenTrader[]) ?? []);
          setState('done');
        }
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [mint]);

  if (state === 'loading') return <SkTable cols={6} rows={6} />;
  if (state === 'error' || !traders) {
    return (
      <div className="card">
        <div className="card-head">
          <h3><span className="ic"><Users size={16} /></span> Smart money in this coin</h3>
        </div>
        <EmptyState
          icon={Users}
          title="No smart money here yet"
          msg="No verified smart wallets currently hold this token, and per-coin trader data is unavailable."
        />
      </div>
    );
  }
  if (traders.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <h3><span className="ic"><Users size={16} /></span> Smart money in this coin</h3>
        </div>
        <EmptyState
          icon={Users}
          title="No smart money here yet"
          msg="No verified smart wallets currently hold this token."
        />
      </div>
    );
  }

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-head">
        <h3><span className="ic"><Users size={16} /></span> Top traders on this coin</h3>
        <span className="badge tag" style={{ fontSize: 11 }}>unverified</span>
      </div>
      <p className="faint" style={{ margin: '0 16px 8px', fontSize: 12 }}>
        No verified smart money here yet — these are the coin&apos;s best per-coin PnL wallets from a live scan. They are not part of the proven smart-money set.
      </p>
      <div className="table-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th>Wallet</th>
              <th className="r">Realized</th>
              <th className="r">Unrealized</th>
              <th className="r">Total PnL</th>
              <th className="r">SOL in</th>
              <th className="r">Last trade</th>
            </tr>
          </thead>
          <tbody>
            {traders.map((t) => (
              <tr
                key={t.wallet}
                className="clickable"
                onClick={() => router.push(`/smart-money/${t.wallet}`)}
              >
                <td><AddrChip address={t.wallet} /></td>
                <td className="r"><Pnl value={t.realizedPnl} unit={false} /></td>
                <td className="r">{t.tokensRemaining > 0 ? <Pnl value={t.unrealizedPnl} unit={false} /> : <span className="faint">—</span>}</td>
                <td className="r"><Pnl value={t.totalPnl} unit={false} /></td>
                <td className="r num">{f.sol(t.solSpent)} <span className="faint" style={{ fontSize: 11 }}>SOL</span></td>
                <td className="r faint" style={{ fontSize: 12 }}>{t.lastTradeAt ? f.ago(+new Date(t.lastTradeAt)) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TitleCard({ mint, token, count }: { mint: string; token?: TokenInfo; count: number | null }) {
  const ticker = token?.symbol || f.short(mint, 4, 4);
  const name = token?.name;
  const icons = token?.icons?.length ? token.icons : iconFor(mint);
  const links = token?.links ?? [];
  const description = token?.description;
  return (
    <div className="card card-pad">
      <div className="row gap-16 wrap">
        <TokenMark symbol={ticker} size={52} icons={icons} />
        <div className="stack" style={{ gap: 3 }}>
          <div className="row gap-8 wrap">
            <h1 style={{ margin: 0, fontSize: 22 }}>{ticker}</h1>
            {name && <span className="muted" style={{ fontSize: 14 }}>{name}</span>}
          </div>
          <span className="row gap-8 wrap">
            <code className="mono faint" style={{ fontSize: 12 }}>{f.short(mint, 8, 8)}</code>
            <CopyIconButton text={mint} title="Copy mint" />
            {links.map((l) => (
              <a
                key={l.url}
                className="iconbtn"
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                title={l.kind}
                onClick={(e) => e.stopPropagation()}
              >
                <LinkIcon kind={l.kind} />
              </a>
            ))}
          </span>
        </div>
        <span className="spacer" />
        {count != null && count > 0 && (
          <span className="badge accent">
            <Sparkles size={12} /> {count} smart holders
          </span>
        )}
      </div>
      {description && (
        <p className="faint" style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, maxWidth: '80ch' }}>
          {description}
        </p>
      )}
    </div>
  );
}

export default function TokenSmartHolders({ mint }: TokenSmartHoldersProps) {
  const router = useRouter();
  const [data, setData] = useState<SmartHoldersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function scan() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/token/${mint}/smart-holders`);
        if (!res.ok) {
          let message = 'Scan failed';
          try {
            const body = await res.json();
            if (body?.error) message = body.error;
          } catch {
            // ignore JSON parse failures, keep default message
          }
          throw new Error(message);
        }
        const json = (await res.json()) as SmartHoldersResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Scan failed');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    scan();
    return () => {
      cancelled = true;
    };
  }, [mint, reloadKey]);

  // ---- loading skeleton ----
  if (loading && !data) {
    return (
      <div className="view stack gap-20">
        <SkCard h={110} />
        <SkCard h={460} />
        <div className="stat-grid cols-4"><SkStat /><SkStat /><SkStat /><SkStat /></div>
        <SkTable cols={8} rows={8} />
      </div>
    );
  }

  // ---- error ----
  if (error) {
    return (
      <div className="view stack gap-20">
        <TitleCard mint={mint} token={data?.token} count={null} />
        <div className="card">
          <ErrorState
            title="Couldn’t load token"
            msg={error}
            onRetry={retry}
          />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const holders = data.smartHolders ?? [];
  const smartHolders = data.smartHolderCount ?? holders.length;
  // Live, marked-to-market aggregates across the smart holders.
  const valueHeld = holders.reduce((a, h) => a + (h.currentValueSol || 0), 0);
  const unrealizedTotal = holders.reduce((a, h) => a + (h.unrealizedSol || 0), 0);
  const hasLive = holders.some((h) => h.currentValueSol > 0);
  const roiVals = holders.map((h) => h.allTimeRoiPct).filter((v): v is number => v != null && Number.isFinite(v));
  const avgRoi = roiVals.length ? roiVals.reduce((a, v) => a + v, 0) / roiVals.length : null;
  const tk = data.token;
  const chg = tk?.priceChange24h;
  const priceSol = data.priceSol ?? 0;

  // Net smart-money flow series (cumulative signed SOL: buys − sells over time).
  const flow = data.netFlowSeries ?? [];
  const flowEnd = flow.length ? flow[flow.length - 1] : 0;
  const flowColor = flowEnd >= 0 ? CHART_COLORS.POS : CHART_COLORS.NEG;

  // Conviction band — aggregate the per-holder position state.
  const stillHolding = holders.filter((h) => h.tokensRemaining > 0).length;
  const exited = holders.length - stillHolding;
  // Net SOL committed by smart money on this coin = end of the cumulative
  // buys-minus-sells series (falls back to gross SOL bought if no series).
  const netSol = flow.length ? flowEnd : holders.reduce((a, h) => a + (h.solBought || 0), 0);

  return (
    <div className="view stack gap-20">
      <TitleCard mint={mint} token={data?.token} count={smartHolders} />

      {/* Live market stats (DexScreener) */}
      {tk && (tk.marketCapUsd != null || tk.priceUsd != null) && (
        <div className="metricbar">
          <div className="mseg"><div className="k">Market cap</div><div className="v num">{usd(tk.marketCapUsd)}</div></div>
          <div className="mseg"><div className="k">Price</div><div className="v num">{usd(tk.priceUsd)}</div></div>
          <div className="mseg"><div className="k">Liquidity</div><div className="v num">{usd(tk.liquidityUsd)}</div></div>
          <div className="mseg"><div className="k">Volume 24h</div><div className="v num">{usd(tk.volume24hUsd)}</div></div>
          <div className="mseg"><div className="k">24h</div><div className={`v num ${chg == null ? '' : chg >= 0 ? 'pos' : 'neg'}`}>{chg == null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`}</div></div>
        </div>
      )}

      {/* Live DexScreener chart */}
      {tk?.pairAddress && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head">
            <h3><span className="ic"><LineChart size={16} /></span> Live chart</h3>
            <a
              className="faint"
              style={{ fontSize: 12, textDecoration: 'none' }}
              href={`https://dexscreener.com/solana/${tk.pairAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open full chart on DexScreener"
            >
              DexScreener ↗
            </a>
          </div>
          {/* Eager-load (not lazy): this is the card's primary content, and a
              lazy iframe inside an `overflow:hidden` card can stay blank when the
              intersection math is thrown off. The header link above is always a
              working fallback if the embed itself fails to render. */}
          <iframe
            src={`https://dexscreener.com/solana/${tk.pairAddress}?embed=1&theme=dark&info=0&trades=0`}
            title="DexScreener chart"
            // Responsive height: shorter on small/mobile viewports, capped at
            // 460px on desktop. Avoids a 460px chart dominating a phone screen.
            style={{ width: '100%', height: 'clamp(320px, 52vh, 460px)', border: 0, display: 'block' }}
          />
        </div>
      )}

      {/* Net smart-money flow — cumulative signed SOL (buys − sells) over time */}
      {flow.length >= 2 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head">
            <h3><span className="ic"><Activity size={16} /></span> Net smart-money flow</h3>
            <span className={`num ${flowEnd >= 0 ? 'pos' : 'neg'}`} style={{ fontSize: 13, fontWeight: 650 }}>
              {f.solSigned(flowEnd)} SOL
            </span>
          </div>
          <div style={{ padding: '4px 8px 8px' }}>
            <AreaChart values={flow} height={158} color={flowColor} fmtY={(v) => f.sol(Number(v))} />
          </div>
          <p className="faint" style={{ margin: '0 16px 12px', fontSize: 12 }}>
            Cumulative SOL bought minus sold by verified smart wallets, bucketed by hour.
          </p>
        </div>
      )}

      <div className="stat-grid cols-4">
        <div className="stat">
          <div className="stat-label"><span className="stat-ic accent"><Users size={15} /></span> Smart holders</div>
          <div className="stat-val num">{smartHolders}</div>
          <div className="stat-foot"><span className="faint">verified wallets holding now</span></div>
        </div>
        <div className="stat">
          <div className="stat-label"><span className="stat-ic pos"><Wallet size={15} /></span> Value held</div>
          <div className="stat-val num">{hasLive ? f.sol(valueHeld) : '—'}<span className="unit">SOL</span></div>
          <div className="stat-foot"><span className="faint">remaining bags at live price</span></div>
        </div>
        <div className="stat">
          <div className="stat-label"><span className="stat-ic"><TrendingUp size={15} /></span> Unrealized PnL</div>
          <div className="stat-val">{hasLive ? <Pnl value={unrealizedTotal} /> : <span className="faint">—</span>}</div>
          <div className="stat-foot"><span className="faint">open positions, marked to market</span></div>
        </div>
        <div className="stat">
          <div className="stat-label"><span className="stat-ic"><TrendingUp size={15} /></span> Avg wallet ROI</div>
          <div className="stat-val num">{avgRoi == null ? '—' : <Roi value={avgRoi} />}</div>
          <div className="stat-foot"><span className="faint">all-time, across these holders</span></div>
        </div>
      </div>

      {holders.length === 0 ? (
        <TopTradersFallback mint={mint} />
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head">
            <h3><span className="ic"><Sparkles size={16} /></span> Smart money in this coin</h3>
            <span className="faint" style={{ fontSize: 12 }}>Sorted by position value</span>
          </div>
          {/* Conviction band */}
          <div className="row gap-8 wrap" style={{ padding: '0 16px 10px', fontSize: 12.5 }}>
            <span className="faint">{holders.length} holders</span>
            <span className="faint">·</span>
            <span className="pos">{stillHolding} still holding</span>
            <span className="faint">·</span>
            <span className="neg">{exited} exited</span>
            <span className="faint">·</span>
            <span className="faint">net</span>
            <span className={`num ${netSol >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 650 }}>{f.solSigned(netSol)} SOL</span>
          </div>
          <div className="table-wrap">
            <table className="dt">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th className="c">Tier</th>
                  <th className="r">Wallet ROI</th>
                  <th className="r">Value</th>
                  <th className="r">Unrealized</th>
                  <th className="r">Realized</th>
                  <th className="c">Position</th>
                  <th className="r">Entry price</th>
                </tr>
              </thead>
              <tbody>
                {holders.map((h) => {
                  const pos = positionFor(h);
                  return (
                    <tr
                      key={h.wallet}
                      className="clickable"
                      onClick={() => router.push(`/smart-money/${h.wallet}`)}
                    >
                      <td><AddrChip address={h.wallet} /></td>
                      <td className="c"><TierBadge tier={h.tier} /></td>
                      <td className="r"><Roi value={h.allTimeRoiPct} /></td>
                      <td className="r num">{h.currentValueSol > 0 ? <>{f.sol(h.currentValueSol)} <span className="faint" style={{ fontSize: 11 }}>SOL</span></> : <span className="faint">—</span>}</td>
                      <td className="r">{h.currentValueSol > 0 || h.unrealizedSol !== 0 ? <Pnl value={h.unrealizedSol} unit={false} /> : <span className="faint">—</span>}</td>
                      <td className="r"><Pnl value={h.pnlOnThisCoin} unit={false} /></td>
                      <td className="c"><span className={`badge ${pos.cls}`}>{pos.label}</span></td>
                      <td className="r">
                        {h.avgCostSol > 0 ? (
                          <div className="stack" style={{ gap: 1, alignItems: 'flex-end' }}>
                            <span className="num">{f.sol(h.avgCostSol)} <span className="faint" style={{ fontSize: 10 }}>SOL</span></span>
                            {priceSol > 0 && (
                              <Roi value={(priceSol / h.avgCostSol - 1) * 100} />
                            )}
                            {h.lastBuy && (
                              <span className="faint" style={{ fontSize: 10.5 }}>{f.ago(+new Date(h.lastBuy))}</span>
                            )}
                          </div>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
