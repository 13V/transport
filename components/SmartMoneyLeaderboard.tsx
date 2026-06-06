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
} from 'lucide-react';
import * as f from '@/lib/format';
import {
  TierBadge,
  Roi,
  Pnl,
  EmptyState,
  ErrorState,
  SkTable,
  AddrChip,
  WatchStar,
  CopyIconButton,
  WalletLinks,
} from '@/components/ui';

/**
 * A wallet as returned by GET /api/smart-money/list (JSON `wallets[]`). This is
 * the gate-filtered set (up to 20k) — search / sort / filter run over the FULL
 * set, then we paginate client-side, so the controls are correct across every
 * smart wallet rather than only the first page.
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
  generatedAt: string;
  wallets: ListWallet[];
}

type SortField = 'rank' | 'roiPct' | 'pnl' | 'winRate';
type SortDirection = 'asc' | 'desc';
type PageSize = 10 | 25 | 50;
type ActiveWithin = 'any' | '1' | '7';

/** Parse an ISO timestamp to epoch ms (or null) for f.ago(). */
function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export default function SmartMoneyLeaderboard({ initialQuery = '' }: { initialQuery?: string }) {
  const router = useRouter();
  const [data, setData] = useState<ListWallet[]>([]);
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

  // Fetch the gate-filtered smart-wallet set. The server-side q / minPnl /
  // activeDays / gate params narrow the set; everything else (tier, ROI, sort,
  // pagination) is applied client-side over the FULL returned set so the
  // controls stay correct across all smart wallets.
  const fetchLeaderboard = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('limit', '20000');
      params.set('sort', sortField === 'roiPct' ? 'roi' : 'score');
      params.set('gate', smartOnly ? '1' : '0');
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      const minPnlNum = parseFloat(minPnl);
      if (!Number.isNaN(minPnlNum)) params.set('minPnl', String(minPnlNum));
      if (activeWithin !== 'any') params.set('activeDays', activeWithin);

      const response = await fetch(`/api/smart-money/list?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch leaderboard');

      const json = (await response.json()) as ListResponse;
      setData(json.wallets ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard');
    } finally {
      setLoading(false);
    }
  }, [sortField, smartOnly, searchQuery, minPnl, activeWithin]);

  // Fetch on mount and whenever a server-side filter changes.
  useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(() => fetchLeaderboard(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchLeaderboard]);

  // Filter and sort the full set client-side. Search / min-PnL / active-within
  // are already applied server-side, but we re-apply search and tier here so the
  // table is consistent even before a refetch lands.
  const filteredData = useMemo(() => {
    let result = [...data];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((w) => w.address.toLowerCase().includes(query));
    }

    // Tier filter — `tier` is returned by the list endpoint, so this is correct
    // across the full set.
    if (tierFilter !== 'All') {
      result = result.filter((w) => w.tier === tierFilter);
    }

    // Min ROI% (wallets without a known ROI are excluded).
    const minRoiNum = parseFloat(minRoi);
    if (!Number.isNaN(minRoiNum)) {
      result = result.filter((w) => w.roiPct != null && w.roiPct >= minRoiNum);
    }

    // Sorting. `rank` maps to the server's default ordering (score desc).
    const dir = sortDirection === 'asc' ? 1 : -1;
    if (sortField === 'rank') {
      result.sort((a, b) => (dir === 1 ? b.score - a.score : a.score - b.score));
    } else {
      result.sort((a, b) => {
        let av: number;
        let bv: number;
        if (sortField === 'roiPct') {
          av = a.roiPct == null ? -1e9 : a.roiPct;
          bv = b.roiPct == null ? -1e9 : b.roiPct;
        } else if (sortField === 'pnl') {
          av = a.pnl;
          bv = b.pnl;
        } else {
          av = a.winRate;
          bv = b.winRate;
        }
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }

    return result;
  }, [data, searchQuery, tierFilter, minRoi, sortField, sortDirection]);

  // Paginate filtered data
  const maxPage = Math.ceil(filteredData.length / pageSize) || 1;
  const safePage = Math.min(currentPage, maxPage - 1);
  const paginatedData = useMemo(() => {
    const start = safePage * pageSize;
    return filteredData.slice(start, start + pageSize).map((w, i) => ({
      ...w,
      rank: start + i + 1,
    }));
  }, [filteredData, safePage, pageSize]);

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
  }: {
    field: SortField;
    label: string;
    align?: 'r' | 'c';
    tip?: string;
  }) => {
    const on = sortField === field;
    return (
      <th className={align}>
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
      <select
        className="select sm"
        value={tierFilter}
        onChange={(e) => {
          setTierFilter(e.target.value as 'All' | 'S' | 'A' | 'B' | 'C');
          setCurrentPage(0);
        }}
      >
        <option value="All">All tiers</option>
        <option value="S">Tier S</option>
        <option value="A">Tier A</option>
        <option value="B">Tier B</option>
        <option value="C">Tier C</option>
      </select>
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
        {filteredData.length} wallet{filteredData.length !== 1 ? 's' : ''}
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
    const total = filteredData.length;
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
  if (loading) {
    return (
      <div className="view stack gap-16">
        {pageHead}
        <SkTable cols={9} rows={12} />
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
            msg="The ranking service didn’t respond. Cached data may be stale."
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
          <table className="dt ruled">
            <thead>
              <tr>
                <SortTh field="rank" label="#" />
                <th>Wallet</th>
                <th className="c">Tier</th>
                <SortTh
                  field="roiPct"
                  label="ROI"
                  align="r"
                  tip="Realized ROI = realized PnL ÷ cost of sold tokens, all-time (FIFO)"
                />
                <SortTh field="pnl" label="PnL" align="r" />
                <SortTh field="winRate" label="Win" align="r" />
                <th>Last active</th>
                <th>Traits</th>
                <th className="r" style={{ width: 220 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginatedData.map((w) => {
                const traits: string[] = [];
                if (w.verified) traits.push('Verified');
                if (w.seeded) traits.push('Trusted');
                const lastMs = toMs(w.lastTradeAt);
                return (
                  <tr
                    key={w.address}
                    className="clickable"
                    onClick={() => handleWalletClick(w.address)}
                  >
                    <td className={`rank ${w.rank <= 3 ? 'top' : ''}`}>{w.rank}</td>
                    <td>
                      <div className="row gap-8" style={{ flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                        <AddrChip address={w.address} copy={false} />
                        {w.verified && (
                          <span
                            className="wmark"
                            title="Deep-scanned — accurate all-time ROI"
                          >
                            <BadgeCheck size={12} />
                          </span>
                        )}
                        {w.seeded && (
                          <span className="wmark faint" title="Trusted smart wallet">
                            <Sparkles size={12} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="c"><TierBadge tier={w.tier} /></td>
                    <td className="r"><Roi value={w.roiPct} /></td>
                    <td className="r"><Pnl value={w.pnl} /></td>
                    <td className="r num faint">{Math.round(w.winRate * 100)}%</td>
                    <td className="faint num" style={{ whiteSpace: 'nowrap' }}>
                      {f.ago(lastMs)}
                    </td>
                    <td>
                      <div className="row gap-8" style={{ flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                        {traits.length > 0 ? (
                          traits.map((t) => <span key={t} className="badge tag">{t}</span>)
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </div>
                    </td>
                    <td className="r">
                      <div
                        className="row-actions"
                        style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}
                        onClick={(e) => e.stopPropagation()}
                      >
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
