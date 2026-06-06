'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft, Clock, ExternalLink, CheckCircle, Star, Wallet,
  TrendingUp, TrendingDown, List, GitBranch, Link as LinkIcon, Sparkles,
} from 'lucide-react';
import * as f from '@/lib/format';
import {
  TierBadge, Roi, Pnl, TokenMark, SourceBadge, EmptyState, ErrorState,
  SkCard, CopyIconButton, WatchStar, TradeLinks, WalletLinks,
} from '@/components/ui';
import Link from 'next/link';
import WalletHistoryChart from './WalletHistoryChart';

/**
 * WALLET PROFILE (premium-analytics view)
 *
 * Renders a single wallet's full performance profile by stitching together the
 * /profile, /holdings and /cluster APIs. Restyled to the deep-slate terminal design while
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

interface ClusterMember {
  wallet: string;
  roiPct: number | null;
  verified: boolean;
}

interface ClusterResponse {
  address: string;
  memberCount: number;
  members: ClusterMember[];
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
  const [clusterMembers, setClusterMembers] = useState<ClusterMember[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Cluster ROI is enrichment: fetch it in parallel with the core profile so
    // it never gates the main render, and never let a failure here break the
    // core profile view.
    async function loadCluster() {
      try {
        const clusterRes = await fetch(`/api/wallet/${walletAddress}/cluster`);
        if (clusterRes.ok) {
          const clusterJson = (await clusterRes.json()) as ClusterResponse;
          if (!cancelled) {
            setClusterMembers(
              Array.isArray(clusterJson?.members) ? clusterJson.members : []
            );
          }
        }
      } catch {
        /* enrichment only — ignore */
      }
    }

    async function load() {
      setLoading(true);
      setError(null);
      setClusterMembers(null);
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
    loadCluster();
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

  // Cluster ROI: map member wallet -> {roiPct, verified} for the funding section.
  const clusterStatByWallet = new Map<string, ClusterMember>();
  for (const m of clusterMembers ?? []) clusterStatByWallet.set(m.wallet, m);

  // "This week's new positions": tokens BOUGHT in the last 7 days that the
  // wallet still holds (intersect recent BUY trades with current holdings).
  const heldMints = new Set(holdingList.map((h) => h.mint));
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const seenNew = new Set<string>();
  const newThisWeek = (profile.recentTrades ?? []).filter((t) => {
    if (String(t.type).toUpperCase() !== 'BUY') return false;
    const at = toMs(t.at);
    if (at == null || at < weekAgoMs) return false;
    if (!heldMints.has(t.mint)) return false;
    if (seenNew.has(t.mint)) return false;
    seenNew.add(t.mint);
    return true;
  });

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
          <Clock size={12} /> Last trade {f.ago(lastTradeMs)}
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
          <WalletLinks address={walletAddress} />
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
          <div className="kv-item"><div className="k">Consistency</div><div className="v">{stats?.consistency != null ? `${Math.round(stats.consistency * 100)}/100` : '—'}</div></div>
          <div className="kv-item"><div className="k">Total trades</div><div className="v num">{f.num(stats?.totalTrades)}</div></div>
          <div className="kv-item"><div className="k">Tokens traded</div><div className="v num">{f.num(stats?.tokensTraded)}</div></div>
          <div className="kv-item"><div className="k">Invested</div><div className="v num">{f.sol(stats?.investedSol)} SOL</div></div>
          <div className="kv-item"><div className="k">Last trade</div><div className="v" style={{ fontSize: 13 }}>{f.ago(lastTradeMs)}</div></div>
        </div>
      </div>

      {/* Performance history */}
      <WalletHistoryChart walletAddress={walletAddress} />

      {/* This week's new positions */}
      {newThisWeek.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3><span className="ic" style={{ color: 'var(--accent-hover)' }}><Sparkles size={16} /></span> This week’s new positions</h3>
            <span className="faint" style={{ fontSize: 12 }}>Bought in the last 7 days &amp; still held</span>
          </div>
          <div className="card-pad stack gap-8">
            {newThisWeek.map((t, i) => (
              <div className="trade" key={`${t.mint}-${i}`}>
                <span className="tradetype buy">BUY</span>
                <TokenMark symbol={f.short(t.mint, 4, 4)} size={22} />
                <Link href={`/token/${t.mint}`} style={{ textDecoration: 'none' }}>
                  <b style={{ fontSize: 12.5 }}>{f.short(t.mint, 4, 4)}</b>
                </Link>
                <span className="num" style={{ fontSize: 12.5 }}>{f.sol(t.amountSol)} <span className="faint">SOL</span></span>
                <span className="spacer" />
                <span className="faint" style={{ fontSize: 12 }}>{f.ago(toMs(t.at))}</span>
                <TradeLinks mint={t.mint} size="xs" />
              </div>
            ))}
          </div>
        </div>
      )}

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
                <tr>
                  <th>Token</th>
                  <th className="r">Tokens</th>
                  <th className="r">Value (SOL)</th>
                  <th className="r">Unrealized</th>
                  <th className="r">Entry</th>
                  <th className="r">vs now</th>
                  <th className="r">Links</th>
                </tr>
              </thead>
              <tbody>
                {holdingList.map((h) => {
                  const canEnter =
                    h.avgCostSol != null && h.avgCostSol > 0 &&
                    h.priceSol != null && Number.isFinite(h.priceSol);
                  const vsNow = canEnter ? (h.priceSol / h.avgCostSol - 1) * 100 : null;
                  return (
                    <tr key={h.mint}>
                      <td>
                        <Link href={`/token/${h.mint}`} className="row gap-8" style={{ textDecoration: 'none' }}>
                          <TokenMark symbol={f.short(h.mint, 4, 4)} size={24} />
                          <b style={{ fontSize: 12.5 }}>{f.short(h.mint, 4, 4)}</b>
                        </Link>
                      </td>
                      <td className="r num faint">{f.compact(h.tokens)}</td>
                      <td className="r num">{f.sol(h.currentValueSol)}</td>
                      <td className="r"><Pnl value={h.unrealizedSol} unit={false} /></td>
                      <td className="r num faint">{h.avgCostSol != null ? f.sol(h.avgCostSol) : '—'}</td>
                      <td className="r">{vsNow != null ? <Roi value={vsNow} /> : '—'}</td>
                      <td className="r"><TradeLinks mint={h.mint} size="xs" /></td>
                    </tr>
                  );
                })}
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
                  <Link href={`/token/${t.mint}`} style={{ textDecoration: 'none' }}>
                    <b style={{ fontSize: 12.5 }}>{f.short(t.mint, 4, 4)}</b>
                  </Link>
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
            <span className="faint" style={{ fontSize: 12 }}>
              {clusterMembers && clusterMembers.length > 0
                ? `Likely one trader · ${clusterMembers.length} wallet${clusterMembers.length === 1 ? '' : 's'} in entity`
                : 'Likely the same trader'}
            </span>
          </div>
          <div className="card-pad stack gap-16">
            <ClusterSection title="Funded by" links={fundedBy} statByWallet={clusterStatByWallet} router={router} />
            <ClusterSection title="Funded these wallets" links={funded} statByWallet={clusterStatByWallet} router={router} />
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
              <tr><th>Token</th><th className="r">PnL (SOL)</th><th className="r">ROI</th><th className="r">Trades</th><th className="r">Links</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.mint}>
                  <td>
                    <Link href={`/token/${r.mint}`} className="row gap-8" style={{ textDecoration: 'none' }}>
                      <TokenMark symbol={f.short(r.mint, 4, 4)} size={22} />
                      <b style={{ fontSize: 12.5 }}>{f.short(r.mint, 4, 4)}</b>
                    </Link>
                  </td>
                  <td className="r"><Pnl value={r.realizedPnlSol} unit={false} /></td>
                  <td className="r"><Roi value={r.roiPct} /></td>
                  <td className="r num faint">{r.trades}</td>
                  <td className="r"><TradeLinks mint={r.mint} size="xs" /></td>
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
  title, links, statByWallet, router,
}: {
  title: string;
  links: ClusterLink[];
  statByWallet: Map<string, ClusterMember>;
  router: ReturnType<typeof useRouter>;
}) {
  if (!links || links.length === 0) return null;
  return (
    <div className="stack gap-8">
      <span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
      {links.map((l) => {
        const member = statByWallet.get(l.wallet);
        // Prefer the /cluster endpoint's verified ROI; fall back to any roiPct
        // already on the funding link.
        const roi = member?.roiPct ?? l.roiPct ?? null;
        return (
          <div
            className="trade"
            key={l.wallet}
            style={{ cursor: 'pointer' }}
            onClick={() => router.push(`/smart-money/${l.wallet}`)}
          >
            <span className="badge" style={{ color: 'var(--accent-hover)', borderColor: 'var(--accent-ring)', background: 'var(--accent-soft)' }}>
              <LinkIcon size={11} /> {f.short(l.wallet, 4, 4)}
            </span>
            {member?.verified && (
              <span className="badge accent" title="Verified ROI"><CheckCircle size={11} /></span>
            )}
            <span className="num" style={{ fontSize: 12.5 }}>{f.sol(l.amountSol)} <span className="faint">SOL</span></span>
            <span className="faint" style={{ fontSize: 12 }}>{l.transfers} transfer{l.transfers === 1 ? '' : 's'}</span>
            <span style={{ fontSize: 12 }}>{roi != null ? <Roi value={roi} /> : <span className="faint">—</span>}</span>
            <span className="spacer" />
            <span className="faint" style={{ fontSize: 12 }}>{f.ago(toMs(l.lastSeen))}</span>
          </div>
        );
      })}
    </div>
  );
}
