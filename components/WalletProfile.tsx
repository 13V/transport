'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft, Clock, ExternalLink, CheckCircle, Star, Wallet,
  TrendingUp, TrendingDown, List, GitBranch, Link as LinkIcon, Sparkles,
  BarChart3,
} from 'lucide-react';
import * as f from '@/lib/format';
import {
  TierBadge, Roi, Pnl, TokenMark, SourceBadge, EmptyState, ErrorState,
  SkCard, SkLine, CopyIconButton, WatchStar, TradeLinks, WalletLinks,
} from '@/components/ui';
import Link from 'next/link';
import WalletHistoryChart from './WalletHistoryChart';

// Row caps: trim payloads rendered into the DOM so one big wallet never
// balloons the page. The underlying APIs may return more; we only paint these.
const MAX_HOLDINGS = 25;
const MAX_RECENT_TRADES = 15;
const MAX_NEW_THIS_WEEK = 12;

/**
 * Below-the-fold lazy mount: renders a height-reserving placeholder until the
 * section scrolls near the viewport, then swaps in the real children. Reserving
 * `minH` keeps layout shift at zero while the section is deferred.
 */
function LazySection({ minH, children }: { minH: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '400px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  return <div ref={ref} style={shown ? undefined : { minHeight: minH }}>{shown ? children : null}</div>;
}

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

interface RecordCall {
  symbol: string | null;
  mint: string;
  ret: number;
}

interface RecentCall {
  symbol: string | null;
  mint: string;
  windowEnd: string | null;
  ret1h: number | null;
  ret24h: number | null;
}

interface WalletRecordResponse {
  address: string;
  n: number;
  medianRet1h: number | null;
  hitRate1h: number | null;
  medianRet24h: number | null;
  hitRate24h: number | null;
  bestCall: RecordCall | null;
  worstCall: RecordCall | null;
  recentCalls: RecentCall[];
  windowDays: number;
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
  const [record, setRecord] = useState<WalletRecordResponse | null>(null);
  // Per-section load flags so one slow endpoint never blocks the whole page.
  // Only the core `profile` fetch gates the page shell; every other section
  // tracks its own loading and renders its own skeleton independently.
  const [profileLoading, setProfileLoading] = useState(true);
  const [holdingsLoading, setHoldingsLoading] = useState(true);
  const [recordLoading, setRecordLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // All five endpoints fire CONCURRENTLY on mount. Each updates its own state
    // and skeleton flag so the page paints section-by-section as data lands —
    // the headline (profile) does not wait on holdings, record, history, etc.

    setProfileLoading(true);
    setHoldingsLoading(true);
    setRecordLoading(true);
    setError(null);
    setProfile(null);
    setHoldings(null);
    setClusterMembers(null);
    setRecord(null);

    // Core profile — the only fetch that can surface a page-level error.
    (async () => {
      try {
        const res = await fetch(`/api/wallet/${walletAddress}/profile`);
        if (!res.ok) throw new Error(`Failed to load profile (${res.status})`);
        const json = (await res.json()) as ProfileResponse;
        if (!cancelled) setProfile(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load wallet profile');
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();

    // Holdings — independent; failure renders an empty holdings table, not a
    // page error.
    (async () => {
      try {
        const res = await fetch(`/api/wallet/${walletAddress}/holdings`);
        if (res.ok) {
          const json = (await res.json()) as HoldingsResponse;
          if (!cancelled) setHoldings(json);
        }
      } catch {
        /* section-local — ignore */
      } finally {
        if (!cancelled) setHoldingsLoading(false);
      }
    })();

    // Cluster ROI enrichment — never gates render, never breaks the page.
    (async () => {
      try {
        const res = await fetch(`/api/wallet/${walletAddress}/cluster`);
        if (res.ok) {
          const json = (await res.json()) as ClusterResponse;
          if (!cancelled) setClusterMembers(Array.isArray(json?.members) ? json.members : []);
        }
      } catch {
        /* enrichment only — ignore */
      }
    })();

    // Measured track record — its own skeleton so it never blocks the page.
    (async () => {
      try {
        const res = await fetch(`/api/wallet/${walletAddress}/record`);
        if (res.ok) {
          const json = (await res.json()) as WalletRecordResponse;
          if (!cancelled) setRecord(json);
        }
      } catch {
        /* enrichment only — ignore */
      } finally {
        if (!cancelled) setRecordLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [walletAddress, reloadKey]);

  const backBtn = (
    <button className="btn ghost sm" onClick={() => router.push('/smart-money')}>
      <ChevronLeft size={15} /> Leaderboard
    </button>
  );

  // Only the core profile fetch gates the page shell. Once it resolves, every
  // other section streams in under its own skeleton.
  if (profileLoading && !profile) {
    return (
      <div className="view stack gap-20">
        <div className="row">{backBtn}</div>
        <SkCard h={150} />{/* headline */}
        <SkCard h={120} />{/* measured calls */}
        <SkCard h={230} />{/* history */}
        <SkCard h={160} />{/* holdings */}
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
  // Guard on holdings having finished loading so we never flash this empty
  // state while the (independent) holdings fetch is still in flight.
  const isEmpty =
    !holdingsLoading &&
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
  const recent = recentTrades.slice(0, MAX_RECENT_TRADES);
  const holdingRows = holdingList.slice(0, MAX_HOLDINGS);
  const newThisWeekRows = newThisWeek.slice(0, MAX_NEW_THIS_WEEK);
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
          <div className="kv-item"><div className="k" title="Win rate on REALIZED round-trips (tokens actually sold). Excludes un-exited bags, so it can read higher than GMGN's all-position rate.">Realized win rate</div><div className="v">{stats?.winRate != null ? `${Math.round(stats.winRate * 100)}%` : '—'}</div></div>
          <div className="kv-item"><div className="k" title="Share of CLOSED tokens that ended net-positive (realized round-trips only).">Consistency</div><div className="v">{stats?.consistency != null ? `${Math.round(stats.consistency * 100)}/100` : '—'}</div></div>
          <div className="kv-item"><div className="k">Total trades</div><div className="v num">{f.num(stats?.totalTrades)}</div></div>
          <div className="kv-item"><div className="k">Tokens traded</div><div className="v num">{f.num(stats?.tokensTraded)}</div></div>
          <div className="kv-item"><div className="k">Invested</div><div className="v num">{f.sol(stats?.investedSol)} SOL</div></div>
          <div className="kv-item"><div className="k">Last trade</div><div className="v" style={{ fontSize: 13 }}>{f.ago(lastTradeMs)}</div></div>
        </div>
      </div>

      {/* Measured track record — verifiable per-wallet calls. Streams in under
          its own skeleton so a slow /record never blocks the page. */}
      <TrackRecordCard record={record} loading={recordLoading} />

      {/* Performance history */}
      <WalletHistoryChart walletAddress={walletAddress} />

      {/* This week's new positions */}
      {newThisWeekRows.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3><span className="ic" style={{ color: 'var(--accent-hover)' }}><Sparkles size={16} /></span> This week’s new positions</h3>
            <span className="faint" style={{ fontSize: 12 }}>Bought in the last 7 days &amp; still held</span>
          </div>
          <div className="card-pad stack gap-8">
            {newThisWeekRows.map((t, i) => (
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

      {/* Current holdings — own skeleton; independent of the profile fetch. */}
      <div className="card">
        <div className="card-head">
          <h3><span className="ic"><Wallet size={16} /></span> Current holdings</h3>
          {holdingList.length > 0 && (
            <span className="faint" style={{ fontSize: 12.5 }}>
              {holdingList.length > MAX_HOLDINGS && (
                <>Top {MAX_HOLDINGS} of {holdingList.length} · </>
              )}
              Value {f.sol(holdings?.totals?.currentValueSol)} SOL · Unreal <Pnl value={holdings?.totals?.unrealizedSol} unit={false} />
            </span>
          )}
        </div>
        {holdingsLoading ? (
          <div className="card-pad"><SkLine w="100%" h={150} /></div>
        ) : holdingList.length === 0 ? (
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
                {holdingRows.map((h) => {
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

      {/* Best / worst tokens — below the fold; lazy-mounted with reserved space. */}
      <LazySection minH={220}>
        <div className="grid cols-2">
          <TokenTable title="Best tokens" icon={TrendingUp} tone="pos" rows={best} />
          <TokenTable title="Worst tokens" icon={TrendingDown} tone="neg" rows={worst} />
        </div>
      </LazySection>

      {/* Recent trades */}
      {recent.length > 0 && (
        <LazySection minH={260}>
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
        </LazySection>
      )}

      {/* Funding cluster — below the fold; lazy-mounted with reserved space. */}
      {(fundedBy.length > 0 || funded.length > 0) && (
        <LazySection minH={200}>
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
        </LazySection>
      )}
    </div>
  );
}

// --- subcomponents ---------------------------------------------------------

/**
 * MEASURED TRACK RECORD — the trust feature. Renders this wallet's REAL,
 * measured participation in smart-money bursts whose forward outcomes we
 * tracked. When `n === 0` (or the record hasn't loaded), shows a neutral state
 * — never fabricated numbers. Reuses the existing card / headline / .bf-proof
 * look so it reads like the live-feed proof strip.
 */
function TrackRecordCard({ record, loading }: { record: WalletRecordResponse | null; loading: boolean }) {
  const n = record?.n ?? 0;

  const head = (
    <div className="card-head">
      <h3>
        <span className="ic" style={{ color: 'var(--accent-hover)' }}><BarChart3 size={16} /></span>{' '}
        Measured calls
      </h3>
      <span className="faint" style={{ fontSize: 12 }}>
        Forward returns of bursts this wallet bought in · measured from real price history
      </span>
    </div>
  );

  // While the (independent) /record fetch is in flight, hold the slot with a
  // skeleton so the prominent track record never flashes an empty state and the
  // page below it never shifts.
  if (loading && !record) {
    return (
      <div className="card" id="measured-calls" style={{ scrollMarginTop: 80 }}>
        {head}
        <div className="card-pad"><SkLine w="100%" h={120} /></div>
      </div>
    );
  }

  if (n === 0) {
    return (
      <div className="card" id="measured-calls" style={{ scrollMarginTop: 80 }}>
        {head}
        <EmptyState
          icon={BarChart3}
          title="No measured calls yet"
          msg="Accrues as the outcome tracker measures bursts this wallet participates in. Nothing is shown until a real forward return exists."
        />
      </div>
    );
  }

  const rec = record!;
  const best = rec.bestCall;
  const worst = rec.worstCall;

  return (
    <div className="card" id="measured-calls" style={{ scrollMarginTop: 80 }}>
      {head}
      <div className="card-pad stack gap-16">
        {/* One-line proof strip (mirrors the live-feed .bf-proof look). */}
        <div className="bf-proof" title="Measured forward returns of bursts this wallet bought in">
          <span className="bf-proof-tag">measured · last {Math.round(rec.windowDays)}d</span>
          {rec.medianRet1h != null && Number.isFinite(rec.medianRet1h) && (
            <span className="bf-proof-row">
              <span className="bf-proof-leg">
                median <b className={rec.medianRet1h >= 0 ? 'pos' : 'neg'}>{f.pct(rec.medianRet1h)}</b> @1h
              </span>
            </span>
          )}
          {rec.hitRate1h != null && Number.isFinite(rec.hitRate1h) && (
            <span className="bf-proof-row">
              <span className="bf-proof-sep">·</span>
              <span className="bf-proof-leg"><b className="pos">{Math.round(rec.hitRate1h)}%</b> green</span>
            </span>
          )}
          {rec.medianRet24h != null && Number.isFinite(rec.medianRet24h) && (
            <span className="bf-proof-row">
              <span className="bf-proof-sep">·</span>
              <span className="bf-proof-leg">
                median <b className={rec.medianRet24h >= 0 ? 'pos' : 'neg'}>{f.pct(rec.medianRet24h)}</b> @24h
              </span>
            </span>
          )}
          {rec.hitRate24h != null && Number.isFinite(rec.hitRate24h) && (
            <span className="bf-proof-row">
              <span className="bf-proof-sep">·</span>
              <span className="bf-proof-leg"><b className="pos">{Math.round(rec.hitRate24h)}%</b> green @24h</span>
            </span>
          )}
          <span className="bf-proof-row">
            <span className="bf-proof-sep">·</span>
            <span className="bf-proof-leg dim">n={rec.n}</span>
          </span>
        </div>

        {/* Headline stat grid for the same numbers, at-a-glance. */}
        <div className="headline-grid">
          <div className="headline">
            <div className="hl-label">Median @1h</div>
            <div className={`hl-val num ${(rec.medianRet1h ?? 0) >= 0 ? 'pos' : 'neg'}`}>{f.pct(rec.medianRet1h)}</div>
          </div>
          <div className="headline">
            <div className="hl-label">Hit rate @1h</div>
            <div className="hl-val num">{rec.hitRate1h != null ? `${Math.round(rec.hitRate1h)}%` : '—'}</div>
          </div>
          <div className="headline">
            <div className="hl-label">Median @24h</div>
            <div className={`hl-val num ${(rec.medianRet24h ?? 0) >= 0 ? 'pos' : 'neg'}`}>{f.pct(rec.medianRet24h)}</div>
          </div>
          <div className="headline">
            <div className="hl-label">Measured calls</div>
            <div className="hl-val num">{f.num(rec.n)}</div>
          </div>
        </div>

        {/* Best / worst call. */}
        {(best || worst) && (
          <div className="kv">
            {best && (
              <div className="kv-item">
                <div className="k">Best call</div>
                <div className="v" style={{ fontSize: 13 }}>
                  <Link href={`/token/${best.mint}`} style={{ textDecoration: 'none' }}>
                    <b>{best.symbol || f.short(best.mint, 4, 4)}</b>
                  </Link>{' '}
                  <span className={best.ret >= 0 ? 'pos' : 'neg'}>{f.pct(best.ret)}</span>
                </div>
              </div>
            )}
            {worst && (
              <div className="kv-item">
                <div className="k">Worst call</div>
                <div className="v" style={{ fontSize: 13 }}>
                  <Link href={`/token/${worst.mint}`} style={{ textDecoration: 'none' }}>
                    <b>{worst.symbol || f.short(worst.mint, 4, 4)}</b>
                  </Link>{' '}
                  <span className={worst.ret >= 0 ? 'pos' : 'neg'}>{f.pct(worst.ret)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recent measured calls list. */}
        {rec.recentCalls.length > 0 && (
          <div className="stack gap-8">
            <span className="faint" style={{ fontSize: 12, fontWeight: 600 }}>Recent measured calls</span>
            {rec.recentCalls.map((c, i) => (
              <div className="trade" key={`${c.mint}-${i}`}>
                <TokenMark symbol={c.symbol || f.short(c.mint, 4, 4)} size={22} />
                <Link href={`/token/${c.mint}`} style={{ textDecoration: 'none' }}>
                  <b style={{ fontSize: 12.5 }}>{c.symbol || f.short(c.mint, 4, 4)}</b>
                </Link>
                <span className="spacer" />
                {c.ret1h != null && (
                  <span style={{ fontSize: 12.5 }}>
                    <span className="faint">1h</span>{' '}
                    <b className={c.ret1h >= 0 ? 'pos' : 'neg'}>{f.pct(c.ret1h)}</b>
                  </span>
                )}
                {c.ret24h != null && (
                  <span style={{ fontSize: 12.5 }}>
                    <span className="faint">24h</span>{' '}
                    <b className={c.ret24h >= 0 ? 'pos' : 'neg'}>{f.pct(c.ret24h)}</b>
                  </span>
                )}
                <span className="faint" style={{ fontSize: 12 }}>{f.ago(toMs(c.windowEnd))}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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
