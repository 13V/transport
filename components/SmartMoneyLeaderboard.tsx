'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronUp,
  ChevronDown,
  Search,
  Loader,
  ExternalLink,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
} from 'lucide-react';
import CopyButton from './CopyButton';

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

type SortField = 'rank' | 'score' | 'pnl' | 'winRate' | 'updatedAt';
type SortDirection = 'asc' | 'desc';
type PageSize = 10 | 25 | 50;

export default function SmartMoneyLeaderboard() {
  const router = useRouter();
  const [data, setData] = useState<LeaderboardWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<'All' | 'S' | 'A' | 'B' | 'C'>('All');
  const [minRoi, setMinRoi] = useState<string>('');
  const [smartOnly, setSmartOnly] = useState(false);
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [currentPage, setCurrentPage] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [totalWallets, setTotalWallets] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [lastSearches, setLastSearches] = useState<string[]>([]);
  const [showSearchHistory, setShowSearchHistory] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedList, setCopiedList] = useState(false);

  // Copy the curated smart-wallet list (plain addresses) for pasting into a
  // trading terminal watchlist or alert bot.
  const copyWalletList = useCallback(async () => {
    try {
      const res = await fetch('/api/smart-money/list?format=addresses');
      if (!res.ok) throw new Error('list fetch failed');
      const text = await res.text();
      await navigator.clipboard.writeText(text.trim());
      setCopiedList(true);
      setTimeout(() => setCopiedList(false), 2000);
    } catch {
      // Fall back to opening the downloadable list if clipboard is unavailable.
      window.open('/api/smart-money/list?format=addresses', '_blank');
    }
  }, []);

  // Fetch leaderboard data
  const fetchLeaderboard = useCallback(async (offset = 0) => {
    try {
      setRefreshing(true);
      const response = await fetch(`/api/smart-money?limit=100&offset=${offset}`);
      if (!response.ok) throw new Error('Failed to fetch leaderboard');

      const json = (await response.json()) as LeaderboardResponse;
      setData(json.leaderboard);
      setTotalWallets(json.totalWallets);
      setLastUpdated(json.lastUpdated);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
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

  // Load search history from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('smartMoneySearches');
    if (saved) {
      setLastSearches(JSON.parse(saved));
    }
  }, []);

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
    result.sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];

      if (typeof aVal === 'string') {
        aVal = aVal.toLowerCase();
        bVal = (bVal as string).toLowerCase();
      }

      if (sortDirection === 'asc') {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else {
        return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
      }
    });

    return result;
  }, [data, searchQuery, tierFilter, minRoi, smartOnly, sortField, sortDirection]);

  // Paginate filtered data
  const paginatedData = useMemo(() => {
    const start = currentPage * pageSize;
    return filteredData.slice(start, start + pageSize);
  }, [filteredData, currentPage, pageSize]);

  const maxPage = Math.ceil(filteredData.length / pageSize);

  // Handle wallet click
  const handleWalletClick = (address: string) => {
    router.push(`/smart-money/${address}`);
  };

  // Handle search
  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(0);

    // Save to history
    if (query.trim()) {
      const updated = [query, ...lastSearches.filter((s) => s !== query)].slice(0, 5);
      setLastSearches(updated);
      localStorage.setItem('smartMoneySearches', JSON.stringify(updated));
    }
  };

  // Handle sort
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
    setCurrentPage(0);
  };

  // Get score color
  const getScoreColor = (score: number) => {
    if (score >= 70) return 'text-green-400 bg-green-900/20';
    if (score >= 30) return 'text-yellow-400 bg-yellow-900/20';
    return 'text-red-400 bg-red-900/20';
  };

  // Get score badge
  const getScoreBadge = (score: number) => {
    if (score >= 70) return 'badge-success';
    if (score >= 30) return 'badge-warning';
    return 'badge-danger';
  };

  // Tier badge color (S=gold, A=emerald, B=blue, C=gray)
  const getTierColor = (tier?: string) => {
    switch (tier) {
      case 'S':
        return 'bg-amber-500/15 text-amber-400 ring-amber-500/30';
      case 'A':
        return 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30';
      case 'B':
        return 'bg-blue-500/15 text-blue-400 ring-blue-500/30';
      default:
        return 'bg-gray-500/15 text-gray-400 ring-gray-500/30';
    }
  };

  const SortHeader = ({ field, label }: { field: SortField; label: string }) => (
    <button
      onClick={() => handleSort(field)}
      className="flex items-center gap-1 font-semibold hover:text-blue-400 transition-colors"
      aria-label={`Sort by ${label}`}
    >
      {label}
      {sortField === field && (
        sortDirection === 'asc' ? (
          <ChevronUp className="w-4 h-4" />
        ) : (
          <ChevronDown className="w-4 h-4" />
        )
      )}
    </button>
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="text-center py-12">
          <Loader className="w-8 h-8 mx-auto animate-spin text-blue-400 mb-4" />
          <p className="text-gray-400">Loading smart money leaderboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h2 className="text-3xl font-bold">Smart Money Leaderboard</h2>
        <p className="text-gray-400">
          Top {totalWallets.toLocaleString()} wallets ranked by trading performance
          {lastUpdated && (
            <span className="text-xs text-gray-500 ml-2">
              (Updated: {new Date(lastUpdated).toLocaleTimeString()})
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={copyWalletList}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-400 ring-1 ring-emerald-500/30 hover:bg-emerald-500/20 transition-colors"
            title="Copy curated smart-wallet addresses to your clipboard"
          >
            {copiedList ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copiedList ? 'Copied!' : 'Copy smart wallet list'}
          </button>
          <a
            href="/api/smart-money/list?format=csv"
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-300 ring-1 ring-gray-700 hover:bg-gray-700 transition-colors"
            title="Download the curated list as CSV (address + stats)"
          >
            <Download className="w-4 h-4" />
            CSV
          </a>
        </div>
      </div>

      {/* Search Bar */}
      <div className="max-w-2xl space-y-3">
        <div className="relative">
          <input
            type="text"
            placeholder="Search by wallet address..."
            value={searchQuery}
            onChange={(e) => {
              handleSearch(e.target.value);
              setShowSearchHistory(true);
            }}
            onFocus={() => setShowSearchHistory(true)}
            onBlur={() => setTimeout(() => setShowSearchHistory(false), 200)}
            className="input w-full pl-10 pr-4 py-2"
            aria-label="Search wallets"
          />
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />

          {/* Search History Dropdown */}
          {showSearchHistory && lastSearches.length > 0 && !searchQuery && (
            <div className="absolute top-full mt-2 w-full bg-gray-800 border border-gray-700 rounded-lg shadow-lg z-10">
              <div className="p-2 space-y-1">
                <p className="text-xs font-semibold text-gray-400 px-2 py-1">Recent Searches</p>
                {lastSearches.map((search) => (
                  <button
                    key={search}
                    onClick={() => {
                      handleSearch(search);
                      setShowSearchHistory(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-gray-700 rounded text-sm text-gray-300 transition-colors"
                  >
                    {search}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {searchQuery && (
          <p className="text-sm text-gray-400">
            Found {filteredData.length} wallet{filteredData.length !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200">
          {error}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex gap-2">
          <span className="text-sm text-gray-400">Per page:</span>
          {([10, 25, 50] as PageSize[]).map((size) => (
            <button
              key={size}
              onClick={() => {
                setPageSize(size);
                setCurrentPage(0);
              }}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                pageSize === size
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
              aria-pressed={pageSize === size}
            >
              {size}
            </button>
          ))}
        </div>

        <button
          onClick={() => fetchLeaderboard()}
          disabled={refreshing}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white text-sm transition-colors"
          aria-label="Refresh data"
        >
          {refreshing ? (
            <>
              <Loader className="w-4 h-4 inline-block mr-2 animate-spin" />
              Refreshing...
            </>
          ) : (
            '🔄 Refresh'
          )}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="tier-filter" className="text-xs font-semibold text-gray-400">
            Tier
          </label>
          <select
            id="tier-filter"
            value={tierFilter}
            onChange={(e) => {
              setTierFilter(e.target.value as 'All' | 'S' | 'A' | 'B' | 'C');
              setCurrentPage(0);
            }}
            className="rounded-lg bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="All">All</option>
            <option value="S">S</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="min-roi" className="text-xs font-semibold text-gray-400">
            Min ROI %
          </label>
          <input
            id="min-roi"
            type="number"
            inputMode="numeric"
            placeholder="e.g. 25"
            value={minRoi}
            onChange={(e) => {
              setMinRoi(e.target.value);
              setCurrentPage(0);
            }}
            className="w-28 rounded-lg bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer pb-1.5">
          <input
            type="checkbox"
            checked={smartOnly}
            onChange={(e) => {
              setSmartOnly(e.target.checked);
              setCurrentPage(0);
            }}
            className="h-4 w-4 rounded border-gray-700 bg-gray-800 text-blue-600 focus:ring-blue-500"
          />
          Smart only
        </label>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-gray-300">
              <th className="px-4 py-3 font-semibold">
                <SortHeader field="rank" label="Rank" />
              </th>
              <th className="px-4 py-3 font-semibold">Wallet Address</th>
              <th className="px-4 py-3 font-semibold">
                <SortHeader field="score" label="Score" />
              </th>
              <th className="px-4 py-3 font-semibold">Tier</th>
              <th className="px-4 py-3 font-semibold text-right">ROI (all-time)</th>
              <th className="px-4 py-3 font-semibold text-right">
                <SortHeader field="pnl" label="PnL" />
              </th>
              <th className="px-4 py-3 font-semibold text-right">
                <SortHeader field="winRate" label="Win Rate" />
              </th>
              <th className="hidden sm:table-cell px-4 py-3 font-semibold">Consistency</th>
              <th className="hidden md:table-cell px-4 py-3 font-semibold text-right">
                <SortHeader field="updatedAt" label="Last Trade" />
              </th>
              <th className="px-4 py-3 font-semibold text-right">Links</th>
            </tr>
          </thead>
          <tbody>
            {paginatedData.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                  {searchQuery
                    ? 'No wallets found matching your search'
                    : 'No data available'}
                </td>
              </tr>
            ) : (
              paginatedData.map((wallet) => (
                <tr
                  key={wallet.address}
                  className="table-row cursor-pointer hover:bg-gray-800/50"
                  onClick={() => handleWalletClick(wallet.address)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleWalletClick(wallet.address);
                    }
                  }}
                >
                  <td className="px-4 py-3 font-bold text-gray-300">#{wallet.rank}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <code className="text-xs bg-gray-800 px-2 py-1 rounded text-gray-300 font-mono">
                        {wallet.address.slice(0, 8)}...{wallet.address.slice(-4)}
                      </code>
                      {wallet.smart && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 ring-1 ring-emerald-500/30"
                          title={
                            wallet.seeded
                              ? 'Manually-trusted smart wallet'
                              : 'Clears the smart-money quality gate'
                          }
                        >
                          {wallet.seeded ? '⭐ Smart' : 'Smart'}
                        </span>
                      )}
                      {wallet.fundedBy && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] font-semibold text-purple-300 ring-1 ring-purple-500/30"
                          title={`Funded with SOL by a smart wallet (${wallet.fundedBy.slice(0, 8)}…) — likely the same trader`}
                        >
                          🔗 Funded
                        </span>
                      )}
                      <CopyButton text={wallet.address} label="wallet address" />
                      {wallet.tags && wallet.tags.length > 0 && (
                        <span className="flex flex-wrap items-center gap-1">
                          {wallet.tags.slice(0, 3).map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-300 ring-1 ring-sky-500/30"
                              title={`Tag: ${tag}`}
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${getScoreBadge(
                        wallet.score
                      )} ${getScoreColor(wallet.score)}`}
                    >
                      {wallet.score.toFixed(1)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {wallet.tier ? (
                      <span
                        className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${getTierColor(
                          wallet.tier
                        )}`}
                        title={`Tier ${wallet.tier}`}
                      >
                        {wallet.tier}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {wallet.roiPct == null ? (
                      <span className="text-gray-600" title="Not deep-scanned yet">—</span>
                    ) : (
                      <span
                        className={`font-bold ${wallet.roiPct >= 0 ? 'text-green-400' : 'text-red-400'}`}
                        title="Accurate all-time realized ROI"
                      >
                        {wallet.roiPct >= 0 ? '+' : ''}{wallet.roiPct.toFixed(1)}%
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={
                        wallet.pnl >= 0 ? 'text-green-400 font-semibold' : 'text-red-400'
                      }
                    >
                      {wallet.pnl >= 0 ? '+' : ''}{wallet.pnl.toFixed(2)} SOL
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {(wallet.winRate * 100).toFixed(0)}%
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3 text-gray-400">
                    {wallet.consistency.toFixed(0)}/100
                  </td>
                  <td className="hidden md:table-cell px-4 py-3 text-gray-400 text-right text-xs">
                    {new Date(wallet.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div
                      className="flex justify-end gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <a
                        href={`https://solscan.io/address/${wallet.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 hover:bg-gray-700 rounded transition-colors text-blue-400"
                        title="View on Solscan"
                        aria-label={`View ${wallet.address} on Solscan`}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                      <a
                        href={`https://dexscreener.com/solana/${wallet.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 hover:bg-gray-700 rounded transition-colors text-green-400"
                        title="View on DEXScreener"
                        aria-label={`View ${wallet.address} on DEXScreener`}
                      >
                        📊
                      </a>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {maxPage > 1 && (
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mt-6">
          <p className="text-sm text-gray-400">
            Page {currentPage + 1} of {maxPage} ({filteredData.length} total results)
          </p>

          <div className="flex gap-2">
            <button
              onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
              disabled={currentPage === 0}
              className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:bg-gray-900 disabled:text-gray-600 transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>

            {/* Page numbers */}
            <div className="flex gap-1">
              {Array.from({ length: Math.min(5, maxPage) }, (_, i) => {
                const offset = Math.max(0, Math.min(currentPage - 2, maxPage - 5));
                const pageNum = offset + i;
                return (
                  <button
                    key={pageNum}
                    onClick={() => setCurrentPage(pageNum)}
                    className={`px-3 py-2 rounded text-sm transition-colors ${
                      currentPage === pageNum
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                    }`}
                    aria-pressed={currentPage === pageNum}
                  >
                    {pageNum + 1}
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => setCurrentPage(Math.min(maxPage - 1, currentPage + 1))}
              disabled={currentPage >= maxPage - 1}
              className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:bg-gray-900 disabled:text-gray-600 transition-colors"
              aria-label="Next page"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* Footer Info */}
      <div className="text-xs text-gray-500 text-center py-4 border-t border-gray-800">
        <p>Click any wallet to view detailed analysis. Scores are updated every 5 minutes.</p>
      </div>
    </div>
  );
}
