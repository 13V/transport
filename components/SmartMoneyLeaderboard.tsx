'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Search,
  Copy,
  Check,
  Download,
  Sparkles,
  Info,
  BadgeCheck,
  BarChart3,
} from 'lucide-react';
import * as f from '@/lib/format';
import {
  TierBadge,
  Roi,
  Pnl,
  WinBar,
  EmptyState,
  ErrorState,
  SkTable,
  AddrChip,
  WatchStar,
  CopyIconButton,
  WalletLinks,
} from '@/components/ui';
import { walletLinks } from '@/lib/trade-links';

/**
 * A wallet as returned by GET /api/smart-money/list (JSON `wallets[]`). Search /
 * sort / filter / pagination all run SERVER-SIDE now: we request only the
 * current page (with the active sort + filters as query params) and the endpoint
 * returns just that slice plus `total` for the pager. The browser never pulls
 * the full set.
 */
interface ListWallet {
  address: string;
  score: number;
  tier?: string;
  pnl: number;
  roiPct: number | null;
  investedSol: number | null;
  verified: boolean;
  winRate: number;
  consistency: number;
  totalTrades: number;
  tokensTraded: number;
  lastTradeAt: string | null;
  seeded: boolean;
}

interface ListResponse {
  count: number;
  total: number;
  page: number;
  pageSize: number;
  generatedAt: string;
  wallets: ListWallet[];
}

type SortField = 'rank' | 'roiPct' | 'pnl' | 'winRate';
type SortDirection = 'asc' | 'desc';
type PageSize = 10 | 25 | 50;
type ActiveWithin = 'any' | '1' | '7';

/** Map a UI sort field to the server's `sort` param. */
const SORT_PARAM: Record<SortField, string> = {
  rank: 'score',
  roiPct: 'roi',
  pnl: 'pnl',
  winRate: 'winrate',
};

/** Parse an ISO timestamp to epoch ms (or null) for f.ago(). */
function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Per-tier CSS var for subtle row/rank accents (matches the .tier-* palette). */
const TIER_VAR: Record<string, string> = {
  S: 'var(--tier-s)',
  A: 'var(--tier-a)',
  B: 'var(--tier-b)',
  C: 'var(--tier-c)',
};

/**
 * ROI → 0..1 heat fraction for the per-row bar. Log-scaled so a 50% gain reads
 * as meaningful while a 5000% moonshot still pins near full — purely visual.
 */
function roiHeat(roi: number | null): number {
  if (roi == null || !Number.isFinite(roi) || roi <= 0) return 0;
  return Math.max(0.04, Math.min(1, Math.log10(1 + roi) / Math.log10(1 + 2000)));
}

export default function SmartMoneyLeaderboard({ initialQuery = '' }: { initialQuery?: string }) {
  const router = useRouter();
  const [data, setData] = useState<ListWallet[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [tierFilter, setTierFilter] = useState<'All' | 'S' | 'A' | 'B' | 'C'>('All');
  const [minRoi, setMinRoi] = useState<string>('');
  const [minPnl, setMinPnl] = useState<string>('');
  const [activeWithin, setActiveWithin] = useState<ActiveWithin>('any');
  const [smartOnly, setSmartOnly] = useState(true);
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [currentPage, setCurrentPage] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [copiedList, setCopiedList] = useState(false);

  // Seed the address filter from the URL ?q= param (passed by the page wrapper).
  useEffect(() => {
    setSearchQuery(initialQuery);
    setCurrentPage(0);
  }, [initialQuery]);

  // Copy the curated smart-wallet list (plain addresses) for pasting into a
  // trading terminal watchlist or alert bot.
  const copyWalletList = useCallback(async () => {
    try {
      const res = await fetch('/api/smart-money/list?format=addresses');
      if (!res.ok) throw new Error('list fetch failed');
      const text = await res.text();
      await navigator.clipboard.writeText(text.trim());
      setCopiedList(true);
      setTimeout(() => setCopiedList(false), 1600);
    } catch {
      // Fall back to opening the downloadable list if clipboard is unavailable.
      window.open('/api/smart-money/list?format=addresses', '_blank');
    }
  }, []);

  // Fetch ONLY the current page. Every control — search, tier, min-ROI/PnL,
  // active-within, gate, sort and pagination — is pushed into the query so the
  // server returns just this page (plus `total` for the pager). The browser no
  // longer pulls the full 20k set.
  const fetchLeaderboard = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      // Server-side pagination (1-based). currentPage is 0-based in the UI.
      params.set('page', String(currentPage + 1));
      params.set('pageSize', String(pageSize));
      params.set('sort', SORT_PARAM[sortField]);
      // For `rank`, the displayed rank runs inverse to the score: "rank
      // ascending" (rank 1 first) means the HIGHEST score first, i.e. score
      // descending. So flip the direction we send for the score sort. Metric
      // sorts (ROI/PnL/Win) map directly.
      const serverDir =
        sortField === 'rank'
          ? sortDirection === 'asc'
            ? 'desc'
            : 'asc'
          : sortDirection;
      params.set('dir', serverDir);
      params.set('gate', smartOnly ? '1' : '0');
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      if (tierFilter !== 'All') params.set('tier', tierFilter);
      const minRoiNum = parseFloat(minRoi);
      if (!Number.isNaN(minRoiNum)) params.set('minRoi', String(minRoiNum));
      const minPnlNum = parseFloat(minPnl);
      if (!Number.isNaN(minPnlNum)) params.set('minPnl', String(minPnlNum));
      if (activeWithin !== 'any') params.set('activeDays', activeWithin);

      const response = await fetch(`/api/smart-money/list?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch leaderboard');

      const json = (await response.json()) as ListResponse;
      setData(json.wallets ?? []);
      setTotal(json.total ?? 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard');
    } finally {
      setLoading(false);
    }
  }, [
    currentPage,
    pageSize,
    sortField,
    sortDirection,
    smartOnly,
    searchQuery,
    tierFilter,
    minRoi,
    minPnl,
    activeWithin,
  ]);

  // Fetch on mount and whenever the page or any server-side control changes.
  useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  // Auto-refresh every 5 minutes — re-fetches only the CURRENT page.
  useEffect(() => {
    const interval = setInterval(() => fetchLeaderboard(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchLeaderboard]);

  // The server already returned exactly this page, filtered + sorted. Pagination
  // metadata is derived from `total`; ranks are global (page offset + index).
  const maxPage = Math.ceil(total / pageSize) || 1;
  const safePage = Math.min(currentPage, maxPage - 1);
  const paginatedData = useMemo(() => {
    const start = safePage * pageSize;
    return data.map((w, i) => ({ ...w, rank: start + i + 1 }));
  }, [data, safePage, pageSize]);

  const handleWalletClick = (address: string) => {
    router.push(`/smart-money/${address}`);
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection(field === 'rank' ? 'asc' : 'desc');
    }
    setCurrentPage(0);
  };

  // ---- pieces ------------------------------------------------------------
  const SortTh = ({
    field,
    label,
    align,
    tip,
    hideSm,
  }: {
    field: SortField;
    label: string;
    align?: 'r' | 'c';
    tip?: string;
    hideSm?: boolean;
  }) => {
    const on = sortField === field;
    return (
      <th className={`${align ?? ''}${hideSm ? ' hide-sm' : ''}`}>
        <button className={`th-sort ${on ? 'sorted' : ''}`} onClick={() => handleSort(field)}>
          {label}
          {tip && (
            <span className="th-info" title={tip} style={{ display: 'inline-flex', marginLeft: 2 }}>
              <Info size={12} />
            </span>
          )}
          <span className="sort-ic">
            {on ? (
              sortDirection === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />
            ) : (
              <ChevronsUpDown size={13} />
            )}
          </span>
        </button>
      </th>
    );
  };

  const actions = (
    <>
      <button
        className="btn pos-soft sm"
        onClick={copyWalletList}
        title="Copy curated smart-wallet addresses to your clipboard"
      >
        {copiedList ? <Check size={15} /> : <Copy size={15} />}
        {copiedList ? 'Copied' : 'Copy smart wallet list'}
      </button>
      <a
        className="btn sm"
        href="/api/smart-money/list?format=csv"
        title="Download the curated list as CSV (address + stats)"
      >
        <Download size={15} /> CSV
      </a>
    </>
  );

  const pageHead = (
    <div className="page-head">
      <div className="sub" />
      <div className="page-head-actions">{actions}</div>
    </div>
  );

  const toolbar = (
    <div className="lb-bar">
      <div className="search-wrap" style={{ width: 240 }}>
        <span className="search-ic"><Search size={14} /></span>
        <input
          className="input sm"
          placeholder="Filter by address…"
          value={searchQuery}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setCurrentPage(0);
          }}
        />
      </div>
      {/* Explicit sort control — works everywhere (the sortable column headers are
          hidden on phones), so users can sort by ROI / PnL / Win rate on mobile. */}
      <div className="row gap-4" style={{ flexShrink: 0 }}>
        <select
          className="select sm"
          value={sortField}
          aria-label="Sort by"
          title="Sort the leaderboard"
          onChange={(e) => {
            const fld = e.target.value as SortField;
            setSortField(fld);
            setSortDirection(fld === 'rank' ? 'asc' : 'desc');
            setCurrentPage(0);
          }}
        >
          <option value="rank">Sort: Rank</option>
          <option value="roiPct">Sort: ROI</option>
          <option value="pnl">Sort: PnL</option>
          <option value="winRate">Sort: Win rate</option>
        </select>
        <button
          type="button"
          className="iconbtn"
          title={sortDirection === 'asc' ? 'Ascending — tap for descending' : 'Descending — tap for ascending'}
          aria-label="Toggle sort direction"
          onClick={() => {
            setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
            setCurrentPage(0);
          }}
        >
          {sortDirection === 'asc' ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      <div className="seg" title="Filter by quality tier">
        {(['All', 'S', 'A', 'B', 'C'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={tierFilter === t ? 'on' : ''}
            aria-pressed={tierFilter === t}
            onClick={() => {
              setTierFilter(t);
              setCurrentPage(0);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <input
        className="input sm"
        type="number"
        inputMode="numeric"
        placeholder="Min ROI %"
        value={minRoi}
        style={{ width: 110 }}
        onChange={(e) => {
          setMinRoi(e.target.value);
          setCurrentPage(0);
        }}
      />
      <input
        className="input sm"
        type="number"
        inputMode="numeric"
        placeholder="Min PnL (SOL)"
        value={minPnl}
        style={{ width: 130 }}
        onChange={(e) => {
          setMinPnl(e.target.value);
          setCurrentPage(0);
        }}
      />
      <select
        className="select sm"
        value={activeWithin}
        title="Only show wallets that traded within this window"
        onChange={(e) => {
          setActiveWithin(e.target.value as ActiveWithin);
          setCurrentPage(0);
        }}
      >
        <option value="any">Active: any</option>
        <option value="1">Active: 24h</option>
        <option value="7">Active: 7d</option>
      </select>
      <label className="check sm">
        <input
          type="checkbox"
          checked={smartOnly}
          onChange={(e) => {
            setSmartOnly(e.target.checked);
            setCurrentPage(0);
          }}
        />
        <span className="box"><Check size={12} /></span>
        Smart only
      </label>
      <span className="spacer" />
      <span className="faint" style={{ fontSize: 12 }}>
        {total} wallet{total !== 1 ? 's' : ''}
      </span>
      <div className="seg">
        {([10, 25, 50] as PageSize[]).map((size) => (
          <button
            key={size}
            className={pageSize === size ? 'on' : ''}
            onClick={() => {
              setPageSize(size);
              setCurrentPage(0);
            }}
          >
            {size}
          </button>
        ))}
      </div>
    </div>
  );

  const renderPager = () => {
    if (maxPage <= 1) {
      return (
        <div className="row between faint" style={{ fontSize: 12.5 }}>
          <span>{total} wallets</span>
          <span />
        </div>
      );
    }
    const start = Math.max(0, Math.min(safePage - 2, maxPage - 5));
    const nums = Array.from({ length: Math.min(5, maxPage) }, (_, i) => start + i);
    return (
      <div className="row between wrap gap-12 pager">
        <span className="faint" style={{ fontSize: 12.5 }}>
          Page {safePage + 1} of {maxPage} · {total} wallets
        </span>
        <div className="row gap-8">
          <button
            className="btn icon sm"
            disabled={safePage === 0}
            onClick={() => setCurrentPage(safePage - 1)}
          >
            <ChevronLeft size={15} />
          </button>
          <div className="seg pages">
            {nums.map((p) => (
              <button
                key={p}
                className={`seg-num ${p === safePage ? 'on' : ''}`}
                onClick={() => setCurrentPage(p)}
              >
                {p + 1}
              </button>
            ))}
          </div>
          <button
            className="btn icon sm"
            disabled={safePage >= maxPage - 1}
            onClick={() => setCurrentPage(safePage + 1)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
    );
  };

  // ---- states ------------------------------------------------------------
  // Skeleton renders the toolbar (controls are usable instantly) and exactly
  // `pageSize` rows so the table paints at its final height — no layout shift
  // when the page slice arrives.
  if (loading) {
    return (
      <div className="view stack gap-16">
        {pageHead}
        {toolbar}
        <SkTable cols={10} rows={pageSize} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="view stack gap-16">
        {pageHead}
        <div className="card">
          <ErrorState
            title="Leaderboard unavailable"
            msg="Couldn’t load the leaderboard — this is usually transient. Retry."
            onRetry={() => {
              setLoading(true);
              setError(null);
              fetchLeaderboard();
            }}
          />
        </div>
      </div>
    );
  }

  if (paginatedData.length === 0) {
    return (
      <div className="view stack gap-16">
        {pageHead}
        {toolbar}
        <div className="card">
          <EmptyState
            icon={Search}
            title={searchQuery ? 'No wallets match your search' : 'No wallets found'}
            msg={
              searchQuery
                ? `Nothing matches “${f.short(searchQuery, 6, 4)}”. Try clearing filters.`
                : 'Adjust your filters to widen the set.'
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="view stack gap-16">
      {pageHead}
      {toolbar}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="table-wrap">
          <table className="dt ruled compact">
            <thead>
              <tr>
                <SortTh field="rank" label="#" hideSm />
                <th>Wallet</th>
                <th className="c hide-sm">Tier</th>
                <SortTh
                  field="roiPct"
                  label="ROI"
                  align="r"
                  tip="Realized ROI = realized PnL ÷ cost of sold tokens, all-time (FIFO)"
                />
                <SortTh field="pnl" label="PnL" align="r" />
                <SortTh field="winRate" label="Win" align="r" hideSm />
                <th className="r hide-sm" title="Profit consistency across this wallet's traded tokens">Consist</th>
                <th className="r hide-sm" title="Total trades · distinct tokens traded">Trades · Tokens</th>
                <th className="hide-sm">Last active</th>
                <th className="r">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginatedData.map((w) => {
                const lastMs = toMs(w.lastTradeAt);
                const tierColor = w.tier ? TIER_VAR[w.tier] : undefined;
                const heat = roiHeat(w.roiPct);
                const consistPct =
                  Number.isFinite(w.consistency) ? Math.round(w.consistency * 100) : null;
                return (
                  <tr
                    key={w.address}
                    className="clickable"
                    title="Open wallet profile"
                    onClick={() => handleWalletClick(w.address)}
                    // Tier-tinted left rail so the table scans by quality at a glance.
                    style={
                      tierColor
                        ? { boxShadow: `inset 2px 0 0 ${tierColor}` }
                        : undefined
                    }
                  >
                    <td
                      className={`rank hide-sm ${w.rank <= 3 ? 'top' : ''}`}
                      style={w.rank <= 3 && tierColor ? { color: tierColor } : undefined}
                    >
                      {w.rank}
                    </td>
                    <td>
                      <div className="row gap-8" style={{ flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                        <AddrChip address={w.address} copy={false} />
                        <a
                          className="gmgn-btn"
                          href={walletLinks(w.address).find((l) => l.label === 'GMGN')?.url || `https://gmgn.ai/sol/address/${w.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title="Open this wallet on GMGN"
                          aria-label="Open on GMGN"
                        >
                          GMGN
                        </a>
                        {w.verified && (
                          <span
                            className="wmark"
                            title="Verified · deep-scanned — accurate all-time ROI"
                          >
                            <BadgeCheck size={13} />
                          </span>
                        )}
                        {w.seeded && (
                          <span className="wmark faint" title="Trusted smart wallet">
                            <Sparkles size={12} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="c hide-sm"><TierBadge tier={w.tier} /></td>
                    <td className="r">
                      <div
                        className="row gap-8"
                        style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}
                      >
                        <Roi value={w.roiPct} />
                        {/* Subtle ROI heat bar — pure visual, log-scaled. */}
                        <span
                          className={`bar ${w.roiPct != null && w.roiPct < 0 ? '' : 'pos'}`}
                          style={{ width: 40, flexShrink: 0, opacity: heat > 0 ? 1 : 0.35 }}
                          aria-hidden="true"
                        >
                          <i style={{ width: `${Math.round(heat * 100)}%` }} />
                        </span>
                      </div>
                    </td>
                    <td className="r"><Pnl value={w.pnl} /></td>
                    <td className="r hide-sm"><WinBar value={w.winRate} /></td>
                    <td className="r num faint hide-sm">
                      {consistPct != null ? `${consistPct}%` : '—'}
                    </td>
                    <td className="r num faint hide-sm" style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ color: 'var(--text-2)' }}>{w.totalTrades}</span>
                      <span style={{ margin: '0 4px', opacity: 0.5 }}>·</span>
                      {w.tokensTraded}
                    </td>
                    <td className="faint num hide-sm" style={{ whiteSpace: 'nowrap' }}>
                      {f.ago(lastMs)}
                    </td>
                    <td className="r">
                      <div
                        className="row-actions"
                        style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <a
                          className="iconbtn"
                          href={`/smart-money/${w.address}#measured-calls`}
                          title="View this wallet's measured track record (forward returns of bursts it bought in)"
                          aria-label="Measured calls"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5 }}
                        >
                          <BarChart3 size={13} /> calls
                        </a>
                        <WatchStar address={w.address} />
                        <CopyIconButton text={w.address} title="Copy address" />
                        <WalletLinks address={w.address} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {renderPager()}
    </div>
  );
}
