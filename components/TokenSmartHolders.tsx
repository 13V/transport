'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Users, Wallet, TrendingUp, Globe, Twitter, Send, MessageCircle, ExternalLink, LineChart } from 'lucide-react';
import * as f from '@/lib/format';
import {
  TokenMark, TierBadge, Roi, Pnl, AddrChip, CopyIconButton,
  EmptyState, ErrorState, SkCard, SkStat, SkTable,
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
  pnlOnThisCoin: number;
  unrealizedSol: number;
  currentValueSol: number;
  tokensRemaining: number;
  buys: number;
  sells: number;
  lastBuy: string | null;
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
}

// Compact USD formatter for live market stats.
function usd(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
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
            <span className="faint" style={{ fontSize: 12 }}>DexScreener</span>
          </div>
          <iframe
            src={`https://dexscreener.com/solana/${tk.pairAddress}?embed=1&theme=dark&info=0&trades=0`}
            title="DexScreener chart"
            loading="lazy"
            style={{ width: '100%', height: 460, border: 0, display: 'block' }}
          />
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
        <div className="card">
          <div className="card-head">
            <h3><span className="ic"><Sparkles size={16} /></span> Smart money in this coin</h3>
          </div>
          <EmptyState
            icon={Users}
            title="No smart money here yet"
            msg="No verified smart wallets currently hold this token."
          />
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-head">
            <h3><span className="ic"><Sparkles size={16} /></span> Smart money in this coin</h3>
            <span className="faint" style={{ fontSize: 12 }}>Sorted by position value</span>
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
                  <th className="r">Entry</th>
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
                      <td className="r faint" style={{ fontSize: 12 }}>{h.lastBuy ? f.ago(+new Date(h.lastBuy)) : '—'}</td>
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
