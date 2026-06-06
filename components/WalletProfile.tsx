'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft, Clock, ExternalLink, CheckCircle, Star, Wallet,
  TrendingUp, TrendingDown, List, GitBranch, Link as LinkIcon,
} from 'lucide-react';
import * as f from '@/lib/format';
import {
  TierBadge, Roi, Pnl, TokenMark, SourceBadge, EmptyState, ErrorState,
  SkCard, CopyIconButton, WatchStar,
} from '@/components/ui';
import WalletHistoryChart from './WalletHistoryChart';

/**
 * WALLET PROFILE (premium-analytics view)
 *
 * Renders a single wallet's full performance profile by stitching together the
 * /profile and /holdings APIs. Restyled to the deep-slate terminal design while
 * preserving the original data fetching and shapes. Every field is guarded with
 * optional chaining and renders an em dash when missing.
 */

interface ProfileStats {
  score: number | null;
  roiPct: number | null;
  realizedPnl: number | null;
  investedSol: number | null;
  winRate: number | null;
  consistency: number | null;
  totalTrades: number | null;
  tokensTraded: number | null;
  verified: boolean | null;
  seeded: boolean | null;
  fundedBy: string | null;
  lastTradeAt: string | null;
}

interface TokenPnl {
  mint: string;
  realizedPnlSol: number;
  roiPct: number;
  trades: number;
}

interface RecentTrade {
  mint: string;
  type: 'BUY' | 'SELL' | string;
  amountSol: number;
  source: string;
  txHash: string;
  at: string;
}

interface ClusterLink {
  wallet: string;
  amountSol: number;
  transfers: number;
  lastSeen: string;
  roiPct?: number | null;
}

interface ProfileResponse {
  address: string;
  stats: ProfileStats | null;
  perToken: { best: TokenPnl[]; worst: TokenPnl[] };
  recentTrades: RecentTrade[];
  cluster: { funded: ClusterLink[]; fundedBy: ClusterLink[] };
}

interface Holding {
  mint: string;
  tokens: number;
  currentValueSol: number;
  avgCostSol: number;
  unrealizedSol: number;
  priceSol: number;
}

interface HoldingsResponse {
  address: string;
  holdings: Holding[];
  totals: { unrealizedSol: number; currentValueSol: number };
}

interface WalletProfileProps {
  walletAddress: string;
}

const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = +new Date(iso);
  return Number.isFinite(t) ? t : null;
};

export default function WalletProfile({ walletAddress }: WalletProfileProps) {
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [holdings, setHoldings] = useState<HoldingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [profileRes, holdingsRes] = await Promise.all([
          fetch(`/api/wallet/${walletAddress}/profile`),
          fetch(`/api/wallet/${walletAddress}/holdings`),
        ]);

        if (!profileRes.ok) throw new Error(`Failed to load profile (${profileRes.status})`);
        if (!holdingsRes.ok) throw new Error(`Failed to load holdings (${holdingsRes.status})`);

        const profileJson = (await profileRes.json()) as ProfileResponse;
        const holdingsJson = (await holdingsRes.json()) as HoldingsResponse;

        if (!cancelled) {
          setProfile(profileJson);
          setHoldings(holdingsJson);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load wallet profile');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [walletAddress, reloadKey]);

  const backBtn = (
    <button className="btn ghost sm" onClick={() => router.push('/smart-money')}>
      <ChevronLeft size={15} /> Leaderboard
    </button>
  );

  if (loading) {
    return (
      <div className="view stack gap-20">
        <div className="row">{backBtn}</div>
        <SkCard h={150} />
        <SkCard h={230} />
        <div className="grid cols-2"><SkCard h={160} /><SkCard h={160} /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="view stack gap-20">
        <div className="row">{backBtn}</div>
        <div className="card">
          <ErrorState
            title="Couldn’t load wallet"
            msg="The profile service didn’t respond for this address."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </div>
      </div>
    );
  }

  if (!profile) return null;

  const stats = profile.stats;
  const best = profile.perToken?.best ?? [];
  const worst = profile.perToken?.worst ?? [];
  const recentTrades = profile.recentTrades ?? [];
  const cluster = profile.cluster ?? { funded: [], fundedBy: [] };
  const fundedBy = cluster.fundedBy ?? [];
  const funded = cluster.funded ?? [];
  const holdingList = holdings?.holdings ?? [];
  const unrealizedTotal = holdings?.totals?.unrealizedSol ?? null;

  // A valid-but-unscanned wallet: no stats row and nothing else to show.
  const isEmpty =
    !stats &&
    holdingList.length === 0 &&
    recentTrades.length === 0 &&
    best.length === 0 &&
    worst.length === 0;

  if (isEmpty) {
    return (
      <div className="view stack gap-20">
        <div className="row">{backBtn}</div>
        <div className="card">
          <EmptyState
            icon={Wallet}
            title="Wallet not deep-scanned yet"
            msg="We don’t have an accurate ROI for this address. Queue it for a deep scan to populate its full profile."
          />
        </div>
      </div>
    );
  }

  const tier = f.tierFromScore(stats?.score ?? null);
  const recent = recentTrades.slice(0, 15);
  const lastTradeMs = toMs(stats?.lastTradeAt);

  return (
    <div className="view stack gap-20">
      {/* Top row */}
      <div className="row between">
        {backBtn}
        <span className="badge ghost faint" style={{ fontSize: 11 }}>
          <Clock size={12} /> Updated {f.ago(lastTradeMs)}
        </span>
      </div>

      {/* Headline card */}
      <div className="card card-pad stack gap-16">
        <div className="row gap-12 wrap">
          <TierBadge tier={tier} lg />
          <code className="addr" style={{ height: 30, fontSize: 13 }}>{f.short(profile.address, 6, 6)}</code>
          <CopyIconButton text={profile.address} />
          <WatchStar address={profile.address} />
          {stats?.verified && (
            <span className="badge accent"><CheckCircle size={12} /> Verified</span>
          )}
          {stats?.seeded && (
            <span className="badge" style={{ color: 'var(--tier-s)', borderColor: 'var(--tier-s-ring)', background: 'var(--tier-s-soft)' }}>
              <Star size={12} /> Seeded
            </span>
          )}
          <span className="spacer" />
          <a className="btn sm" href={`https://solscan.io/address/${profile.address}`} target="_blank" rel="noopener noreferrer">
            Solscan <ExternalLink size={14} />
          </a>
        </div>

        <div className="headline-grid">
          <div className="headline">
            <div className="hl-label">ROI · all-time</div>
            <div className={`hl-val num ${(stats?.roiPct ?? 0) >= 0 ? 'pos' : 'neg'}`}>{f.pct(stats?.roiPct)}</div>
          </div>
          <div className="headline">
            <div className="hl-label">Realized PnL</div>
            <div className={`hl-val num ${(stats?.realizedPnl ?? 0) >= 0 ? 'pos' : 'neg'}`}>
              {f.solSigned(stats?.realizedPnl)}<span className="unit">SOL</span>
            </div>
          </div>
          <div className="headline">
            <div className="hl-label">Unrealized PnL</div>
            <div className={`hl-val num ${(unrealizedTotal ?? 0) >= 0 ? 'pos' : 'neg'}`}>
              {f.solSigned(unrealizedTotal)}<span className="unit">SOL</span>
            </div>
          </div>
          <div className="headline">
            <div className="hl-label">Score</div>
            <div className="hl-val num">{stats?.score != null ? stats.score.toFixed(1) : '—'}</div>
          </div>
        </div>

        <div className="kv">
          <div className="kv-item"><div className="k">Win rate</div><div className="v">{stats?.winRate != null ? `${Math.round(stats.winRate * 100)}%` : '—'}</div></div>
          <div className="kv-item"><div className="k">Consistency</div><div className="v">{stats?.consistency != null ? `${stats.consistency}/100` : '—'}</div></div>
          <div className="kv-item"><div className="k">Total trades</div><div className="v num">{f.num(stats?.totalTrades)}</div></div>
          <div className="kv-item"><div className="k">Tokens traded</div><div className="v num">{f.num(stats?.tokensTraded)}</div></div>
          <div className="kv-item"><div className="k">Invested</div><div className="v num">{f.sol(stats?.investedSol)} SOL</div></div>
          <div className="kv-item"><div className="k">Last trade</div><div className="v" style={{ fontSize: 13 }}>{f.ago(lastTradeMs)}</div></div>
        </div>
      </div>

      {/* Performance history */}
      <WalletHistoryChart walletAddress={walletAddress} />

      {/* Current holdings */}
      <div className="card">
        <div className="card-head">
          <h3><span className="ic"><Wallet size={16} /></span> Current holdings</h3>
          {holdingList.length > 0 && (
            <span className="faint" style={{ fontSize: 12.5 }}>
              Value {f.sol(holdings?.totals?.currentValueSol)} SOL · Unreal <Pnl value={holdings?.totals?.unrealizedSol} unit={false} />
            </span>
          )}
        </div>
        {holdingList.length === 0 ? (
          <EmptyState icon={Wallet} title="No open positions" msg="This wallet has fully realized every position." />
        ) : (
          <div className="table-wrap">
            <table className="dt compact">
              <thead>
                <tr><th>Token</th><th className="r">Tokens</th><th className="r">Value (SOL)</th><th className="r">Unrealized</th><th className="r">Avg cost</th></tr>
              </thead>
              <tbody>
                {holdingList.map((h) => (
                  <tr key={h.mint}>
                    <td>
                      <span className="row gap-8">
                        <TokenMark symbol={f.short(h.mint, 4, 4)} size={24} />
                        <b style={{ fontSize: 12.5 }}>{f.short(h.mint, 4, 4)}</b>
                      </span>
                    </td>
                    <td className="r num faint">{f.compact(h.tokens)}</td>
                    <td className="r num">{f.sol(h.currentValueSol)}</td>
                    <td className="r"><Pnl value={h.unrealizedSol} unit={false} /></td>
                    <td className="r num faint">{h.avgCostSol != null ? h.avgCostSol.toFixed(6) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Best / worst tokens */}
      <div className="grid cols-2">
        <TokenTable title="Best tokens" icon={TrendingUp} tone="pos" rows={best} />
        <TokenTable title="Worst tokens" icon={TrendingDown} tone="neg" rows={worst} />
      </div>

      {/* Recent trades */}
      {recent.length > 0 && (
        <div className="card">
          <div className="card-head"><h3><span className="ic"><List size={16} /></span> Recent trades</h3></div>
          <div className="card-pad stack gap-8">
            {recent.map((t, i) => {
              const sell = String(t.type).toUpperCase() === 'SELL';
              return (
                <div className="trade" key={`${t.txHash}-${i}`}>
                  <span className={`tradetype ${sell ? 'sell' : 'buy'}`}>{sell ? 'SELL' : 'BUY'}</span>
                  <TokenMark symbol={f.short(t.mint, 4, 4)} size={22} />
                  <b style={{ fontSize: 12.5 }}>{f.short(t.mint, 4, 4)}</b>
                  <span className="num" style={{ fontSize: 12.5 }}>{f.sol(t.amountSol)} <span className="faint">SOL</span></span>
                  {t.source && <SourceBadge source={t.source} />}
                  <span className="spacer" />
                  <span className="faint" style={{ fontSize: 12 }}>{f.ago(toMs(t.at))}</span>
                  {t.txHash && (
                    <a className="iconbtn" href={`https://solscan.io/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer" title="Tx">
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Funding cluster */}
      {(fundedBy.length > 0 || funded.length > 0) && (
        <div className="card">
          <div className="card-head">
            <h3><span className="ic"><GitBranch size={16} /></span> Funding cluster</h3>
            <span className="faint" style={{ fontSize: 12 }}>Likely the same trader</span>
          </div>
          <div className="card-pad stack gap-16">
            <ClusterSection title="Funded by" links={fundedBy} router={router} />
            <ClusterSection title="Funded these wallets" links={funded} router={router} />
          </div>
        </div>
      )}
    </div>
  );
}

// --- subcomponents ---------------------------------------------------------

function TokenTable({
  title, icon: Icon, tone, rows,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number }>;
  tone: 'pos' | 'neg';
  rows: TokenPnl[];
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h3><span className="ic" style={{ color: tone === 'pos' ? 'var(--pos)' : 'var(--neg)' }}><Icon size={16} /></span> {title}</h3>
      </div>
      {!rows || rows.length === 0 ? (
        <EmptyState title="No data" />
      ) : (
        <div className="table-wrap">
          <table className="dt compact">
            <thead>
              <tr><th>Token</th><th className="r">PnL (SOL)</th><th className="r">ROI</th><th className="r">Trades</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.mint}>
                  <td>
                    <span className="row gap-8">
                      <TokenMark symbol={f.short(r.mint, 4, 4)} size={22} />
                      <b style={{ fontSize: 12.5 }}>{f.short(r.mint, 4, 4)}</b>
                    </span>
                  </td>
                  <td className="r"><Pnl value={r.realizedPnlSol} unit={false} /></td>
                  <td className="r"><Roi value={r.roiPct} /></td>
                  <td className="r num faint">{r.trades}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClusterSection({
  title, links, router,
}: {
  title: string;
  links: ClusterLink[];
  router: ReturnType<typeof useRouter>;
}) {
  if (!links || links.length === 0) return null;
  return (
    <div className="stack gap-8">
      <span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
      {links.map((l) => (
        <div
          className="trade"
          key={l.wallet}
          style={{ cursor: 'pointer' }}
          onClick={() => router.push(`/smart-money/${l.wallet}`)}
        >
          <span className="badge" style={{ color: 'var(--accent-hover)', borderColor: 'var(--accent-ring)', background: 'var(--accent-soft)' }}>
            <LinkIcon size={11} /> {f.short(l.wallet, 4, 4)}
          </span>
          <span className="num" style={{ fontSize: 12.5 }}>{f.sol(l.amountSol)} <span className="faint">SOL</span></span>
          <span className="faint" style={{ fontSize: 12 }}>{l.transfers} transfer{l.transfers === 1 ? '' : 's'}</span>
          {l.roiPct != null && <span style={{ fontSize: 12 }}><Roi value={l.roiPct} /></span>}
          <span className="spacer" />
          <span className="faint" style={{ fontSize: 12 }}>{f.ago(toMs(l.lastSeen))}</span>
        </div>
      ))}
    </div>
  );
}
