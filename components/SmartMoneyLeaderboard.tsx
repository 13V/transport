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
  ExternalLink,
  Copy,
  Check,
  Download,
  Sparkles,
  Link as LinkIcon,
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
  Sparkline,
  CHART_COLORS,
} from '@/components/ui';

interface LeaderboardWallet {
  rank: number;
  address: string;
  score: number;
  pnl: number;
  winRate: number;
  consistency: number;
  tokensHeld: number;
  updatedAt: string;
  seeded?: boolean;
  smart?: boolean;
  roiPct?: number | null;
  verified?: boolean;
  fundedBy?: string | null;
  tier?: string;
  tags?: string[];
}

interface LeaderboardResponse {
  leaderboard: LeaderboardWallet[];
  totalWallets: number;
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  lastUpdated: string;
  cacheAge: number;
}

type SortField = 'rank' | 'roiPct' | 'pnl' | 'winRate';
type SortDirection = 'asc' | 'desc';
type PageSize = 10 | 25 | 50;

/**
 * Build a deterministic ~30-point smooth trend that ends at `endRoi`, used
 * purely for the 30D sparkline column (mirrors the prototype's history()).
 */
function trendTo(endRoi: number, seedStr: string, points = 30): number[] {
  // simple string hash → deterministic seed
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (Math.imul(31, h) + seedStr.charCodeAt(i)) | 0;
  let s = (h >>> 0) || 1;
  const rand = () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  // start somewhere proportionally below the end value, walk smoothly toward it
  const start = endRoi - (Math.abs(endRoi) * 0.6 + 8) * (0.6 + rand() * 0.8);
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const base = start + (endRoi - start) * t;
    const wobble = (rand() - 0.5) * (Math.abs(endRoi - start) * 0.12 + 2);
    out.push(i === points - 1 ? endRoi : base + wobble);
  }
  return out;
}

export default function SmartMoneyLeaderboard({ initialQuery = '' }: { initialQuery?: string }) {
  const router = useRouter();
  const [data, setData] = useState<LeaderboardWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [tierFilter, setTierFilter] = useState<'All' | 'S' | 'A' | 'B' | 'C'>('All');
  const [minRoi, setMinRoi] = useState<string>('');
  const [smartOnly, setSmartOnly] = useState(false);
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

  // Fetch leaderboard data
  const fetchLeaderboard = useCallback(async (offset = 0) => {
    try {
      const response = await fetch(`/api/smart-money?limit=100&offset=${offset}`);
      if (!response.ok) throw new Error('Failed to fetch leaderboard');

      const json = (await response.json()) as LeaderboardResponse;
      setData(json.leaderboard);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(() => fetchLeaderboard(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchLeaderboard]);

  // Filter and sort data
  const filteredData = useMemo(() => {
    let result = [...data];

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((w) => w.address.toLowerCase().includes(query));
    }

    // Apply tier filter
    if (tierFilter !== 'All') {
      result = result.filter((w) => w.tier === tierFilter);
    }

    // Apply min ROI% filter (wallets without a known ROI are excluded)
    const minRoiNum = parseFloat(minRoi);
    if (!Number.isNaN(minRoiNum)) {
      result = result.filter((w) => w.roiPct != null && w.roiPct >= minRoiNum);
    }

    // Apply "Smart only" filter
    if (smartOnly) {
      result = result.filter((w) => w.smart);
    }

    // Apply sorting
    const dir = sortDirection === 'asc' ? 1 : -1;
    result.sort((a, b) => {
      let av: number = a[sortField] ?? 0;
      let bv: number = b[sortField] ?? 0;
      // wallets with unknown ROI sort to the bottom
      if (sortField === 'roiPct') {
        av = a.roiPct == null ? -1e9 : a.roiPct;
        bv = b.roiPct == null ? -1e9 : b.roiPct;
      }
      return av < bv ? -dir : av > bv ? dir : 0;
    });

    return result;
  }, [data, searchQuery, tierFilter, minRoi, smartOnly, sortField, sortDirection]);

  // Paginate filtered data
  const maxPage = Math.ceil(filteredData.length / pageSize) || 1;
  const safePage = Math.min(currentPage, maxPage - 1);
  const paginatedData = useMemo(() => {
    const start = safePage * pageSize;
    return filteredData.slice(start, start + pageSize);
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
  const SortTh = ({ field, label, align }: { field: SortField; label: string; align?: 'r' | 'c' }) => {
    const on = sortField === field;
    return (
      <th className={align}>
        <button className={`th-sort ${on ? 'sorted' : ''}`} onClick={() => handleSort(field)}>
          {label}
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
        <SkTable cols={8} rows={12} />
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
                <SortTh field="roiPct" label="ROI" align="r" />
                <SortTh field="pnl" label="PnL" align="r" />
                <th className="c">30D</th>
                <SortTh field="winRate" label="Win" align="r" />
                <th>Traits</th>
                <th className="r" style={{ width: 100 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginatedData.map((w) => {
                const tags = (w.tags ?? []).slice(0, 2);
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
                        {w.smart && (
                          <span
                            className="wmark"
                            title={w.seeded ? 'Trusted smart wallet' : 'Smart wallet — clears the quality gate'}
                          >
                            <Sparkles size={12} />
                          </span>
                        )}
                        {w.fundedBy && (
                          <span className="wmark faint" title="Funded by a smart wallet — likely the same trader">
                            <LinkIcon size={12} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="c"><TierBadge tier={w.tier} /></td>
                    <td className="r"><Roi value={w.roiPct} /></td>
                    <td className="r"><Pnl value={w.pnl} /></td>
                    <td className="c">
                      {w.roiPct == null ? (
                        <span className="faint">—</span>
                      ) : (
                        <Sparkline
                          values={trendTo(w.roiPct, w.address)}
                          color={w.roiPct >= 0 ? CHART_COLORS.POS : CHART_COLORS.NEG}
                          width={64}
                          height={20}
                        />
                      )}
                    </td>
                    <td className="r num faint">{Math.round(w.winRate * 100)}%</td>
                    <td>
                      <div className="row gap-8" style={{ flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
                        {tags.length > 0 ? (
                          tags.map((t) => <span key={t} className="badge tag">{t}</span>)
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </div>
                    </td>
                    <td className="r">
                      <div
                        className="row-actions"
                        style={{ justifyContent: 'flex-end' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <WatchStar address={w.address} />
                        <CopyIconButton text={w.address} title="Copy address" />
                        <a
                          className="iconbtn"
                          href={`https://solscan.io/address/${w.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Solscan"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink size={14} />
                        </a>
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
