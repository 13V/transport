'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Users, Wallet, TrendingUp } from 'lucide-react';
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
  tokensRemaining: number;
  buys: number;
  sells: number;
  lastBuy: string | null;
}

interface SmartHoldersResponse {
  mint: string;
  traderCount: number;
  smartHolderCount: number;
  smartHolders: SmartHolder[];
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

function TitleCard({ mint, sym, count }: { mint: string; sym: string; count: number | null }) {
  return (
    <div className="card card-pad">
      <div className="row gap-16 wrap">
        <TokenMark symbol={sym} size={52} icons={iconFor(mint)} />
        <div className="stack">
          <div className="row gap-8">
            <h1 style={{ margin: 0, fontSize: 22 }}>{sym}</h1>
          </div>
          <span className="row gap-8">
            <code className="mono faint" style={{ fontSize: 12 }}>{f.short(mint, 8, 8)}</code>
            <CopyIconButton text={mint} title="Copy mint" />
          </span>
        </div>
        <span className="spacer" />
        {count != null && count > 0 && (
          <span className="badge accent">
            <Sparkles size={12} /> {count} smart holders
          </span>
        )}
      </div>
    </div>
  );
}

export default function TokenSmartHolders({ mint }: TokenSmartHoldersProps) {
  const router = useRouter();
  const [data, setData] = useState<SmartHoldersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const sym = f.short(mint, 4, 4);

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
        <div className="stat-grid cols-3"><SkStat /><SkStat /><SkStat /></div>
        <SkTable cols={6} rows={8} />
      </div>
    );
  }

  // ---- error ----
  if (error) {
    return (
      <div className="view stack gap-20">
        <TitleCard mint={mint} sym={sym} count={null} />
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
  // Total SOL these smart wallets put into the coin (conviction signal).
  const totalSolIn = holders.reduce((a, h) => a + (h.solBought || 0), 0);
  // Average all-time ROI across the smart wallets holding this coin (real data).
  const roiVals = holders.map((h) => h.allTimeRoiPct).filter((v): v is number => v != null && Number.isFinite(v));
  const avgRoi = roiVals.length ? roiVals.reduce((a, v) => a + v, 0) / roiVals.length : null;

  return (
    <div className="view stack gap-20">
      <TitleCard mint={mint} sym={sym} count={smartHolders} />

      <div className="stat-grid cols-3">
        <div className="stat">
          <div className="stat-label"><span className="stat-ic accent"><Users size={15} /></span> Smart holders</div>
          <div className="stat-val num">{smartHolders}</div>
          <div className="stat-foot"><span className="faint">verified wallets holding now</span></div>
        </div>
        <div className="stat">
          <div className="stat-label"><span className="stat-ic pos"><Wallet size={15} /></span> Smart SOL in</div>
          <div className="stat-val num">{f.sol(totalSolIn)}<span className="unit">SOL</span></div>
          <div className="stat-foot"><span className="faint">bought by these wallets</span></div>
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
                  <th className="r">PnL</th>
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
                      <td className="r num">{f.sol(h.solBought)} <span className="faint" style={{ fontSize: 11 }}>SOL</span></td>
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
