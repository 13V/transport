'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Filter, Loader, TrendingUp } from 'lucide-react';

interface WalletCard {
  rank: number;
  address: string;
  score: number;
  pnl: number;
  winRate: number;
  consistency: number;
  tokensHeld: number;
  updatedAt: string;
}

type TradingStyle = 'Scalpers' | 'Swing Traders' | 'Early Buyers' | 'Long-Term Holders';
type TimeFilter = 'week' | 'month' | 'all';

interface DiscoveryFilters {
  tradingStyle: TradingStyle | 'All';
  scoreMin: number;
  scoreMax: number;
  pnlMin: number;
  pnlMax: number;
  winRateMin: number;
  timeframe: TimeFilter;
}

interface Category {
  name: TradingStyle;
  icon: string;
  description: string;
}

export default function Discovery() {
  const router = useRouter();
  const [wallets, setWallets] = useState<WalletCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<TradingStyle | 'All'>('All');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<DiscoveryFilters>({
    tradingStyle: 'All',
    scoreMin: 0,
    scoreMax: 100,
    pnlMin: -100000,
    pnlMax: 100000,
    winRateMin: 0,
    timeframe: 'month',
  });

  const categories: Category[] = [
    {
      name: 'Scalpers',
      icon: '⚡',
      description: 'High frequency traders, many daily trades',
    },
    {
      name: 'Swing Traders',
      icon: '📈',
      description: 'Medium hold times, capture mid-term trends',
    },
    {
      name: 'Early Buyers',
      icon: '🎯',
      description: 'Entry position traders, first-mover advantage',
    },
    {
      name: 'Long-Term Holders',
      icon: '💎',
      description: 'Patient investors, weeks/months hold time',
    },
  ];

  // Mock discover endpoints
  const fetchDiscoveryData = useCallback(async (category: string) => {
    try {
      setLoading(true);
      // This would call /api/smart-money with filters
      // For now, mock data
      const response = await fetch('/api/smart-money?limit=100&offset=0');
      if (!response.ok) throw new Error('Failed to fetch');

      const data = await response.json();
      // Filter based on category (would be done server-side in production)
      setWallets(data.leaderboard.slice(0, 12));
      setSelectedCategory(category as TradingStyle | 'All');
    } catch (err) {
      console.error('Failed to fetch discovery data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCategoryClick = (category: TradingStyle | 'All') => {
    fetchDiscoveryData(category);
  };

  const handleWalletClick = (address: string) => {
    router.push(`/smart-money/${address}`);
  };

  const getScoreColor = (score: number) => {
    if (score >= 70) return 'text-green-400';
    if (score >= 30) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getScoreBadge = (score: number) => {
    if (score >= 70) return 'bg-green-900/20 text-green-400';
    if (score >= 30) return 'bg-yellow-900/20 text-yellow-400';
    return 'bg-red-900/20 text-red-400';
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <h2 className="text-3xl font-bold">Discover Smart Money</h2>
        <p className="text-gray-400">
          Browse top wallets by trading style, performance, and activity patterns
        </p>
      </div>

      {/* Category Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {categories.map((category) => (
          <button
            key={category.name}
            onClick={() => handleCategoryClick(category.name)}
            className={`card text-left transition-all duration-200 hover:border-blue-500 hover:shadow-lg hover:shadow-blue-500/10 ${
              selectedCategory === category.name ? 'border-blue-500 bg-blue-900/10' : ''
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <span className="text-4xl">{category.icon}</span>
              <ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-blue-400" />
            </div>

            <h3 className="font-semibold text-lg mb-2">{category.name}</h3>
            <p className="text-sm text-gray-400">{category.description}</p>
          </button>
        ))}
      </div>

      {/* Quick Filters */}
      <div className="space-y-4">
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-2 text-blue-400 hover:text-blue-300 transition-colors"
        >
          <Filter className="w-5 h-5" />
          <span>Advanced Filters</span>
        </button>

        {showFilters && (
          <div className="card grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Score Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Smart Money Score</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={filters.scoreMin}
                  onChange={(e) =>
                    setFilters({ ...filters, scoreMin: parseInt(e.target.value) })
                  }
                  className="input w-full text-sm"
                  placeholder="Min"
                />
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={filters.scoreMax}
                  onChange={(e) =>
                    setFilters({ ...filters, scoreMax: parseInt(e.target.value) })
                  }
                  className="input w-full text-sm"
                  placeholder="Max"
                />
              </div>
            </div>

            {/* PnL Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Realized PnL ($)</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={filters.pnlMin}
                  onChange={(e) =>
                    setFilters({ ...filters, pnlMin: parseInt(e.target.value) })
                  }
                  className="input w-full text-sm"
                  placeholder="Min"
                />
                <input
                  type="number"
                  value={filters.pnlMax}
                  onChange={(e) =>
                    setFilters({ ...filters, pnlMax: parseInt(e.target.value) })
                  }
                  className="input w-full text-sm"
                  placeholder="Max"
                />
              </div>
            </div>

            {/* Win Rate Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Min Win Rate (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                value={filters.winRateMin}
                onChange={(e) =>
                  setFilters({ ...filters, winRateMin: parseInt(e.target.value) })
                }
                className="input w-full text-sm"
              />
            </div>

            {/* Timeframe Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Timeframe</label>
              <select
                value={filters.timeframe}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    timeframe: e.target.value as TimeFilter,
                  })
                }
                className="input w-full text-sm"
              >
                <option value="week">This Week</option>
                <option value="month">This Month</option>
                <option value="all">All Time</option>
              </select>
            </div>

            {/* Apply Button */}
            <div className="md:col-span-3 flex gap-2">
              <button
                onClick={() => fetchDiscoveryData(selectedCategory)}
                className="btn btn-primary flex-1"
              >
                Apply Filters
              </button>
              <button
                onClick={() => {
                  setFilters({
                    tradingStyle: 'All',
                    scoreMin: 0,
                    scoreMax: 100,
                    pnlMin: -100000,
                    pnlMax: 100000,
                    winRateMin: 0,
                    timeframe: 'month',
                  });
                  setSelectedCategory('All');
                }}
                className="btn btn-secondary"
              >
                Reset
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      {loading ? (
        <div className="text-center py-12">
          <Loader className="w-8 h-8 mx-auto animate-spin text-blue-400 mb-4" />
          <p className="text-gray-400">Loading wallets...</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-semibold">
              {selectedCategory === 'All'
                ? 'Featured Wallets'
                : `Top ${selectedCategory}`}
            </h3>
            <span className="text-sm text-gray-400">{wallets.length} wallets</span>
          </div>

          {wallets.length === 0 ? (
            <div className="card text-center py-12">
              <p className="text-gray-400">No wallets found matching your filters</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {wallets.map((wallet) => (
                <button
                  key={wallet.address}
                  onClick={() => handleWalletClick(wallet.address)}
                  className="card text-left hover:border-blue-500 transition-all duration-200 hover:shadow-lg hover:shadow-blue-500/10 group"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <p className="text-sm text-gray-400">Rank</p>
                      <p className="text-2xl font-bold text-blue-400">#{wallet.rank}</p>
                    </div>
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-semibold ${getScoreBadge(
                        wallet.score
                      )}`}
                    >
                      {wallet.score.toFixed(1)}
                    </span>
                  </div>

                  {/* Address */}
                  <div className="mb-4">
                    <p className="text-xs text-gray-400 mb-1">Wallet</p>
                    <code className="text-xs bg-gray-800 px-2 py-1 rounded font-mono text-gray-300 block truncate">
                      {wallet.address}
                    </code>
                  </div>

                  {/* Stats */}
                  <div className="space-y-2 mb-4 pt-4 border-t border-gray-800">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Realized PnL</span>
                      <span
                        className={
                          wallet.pnl >= 0 ? 'text-green-400 font-semibold' : 'text-red-400'
                        }
                      >
                        {wallet.pnl >= 0 ? '+' : ''}${(wallet.pnl / 1000).toFixed(1)}k
                      </span>
                    </div>

                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Win Rate</span>
                      <span className="text-blue-400 font-semibold">
                        {(wallet.winRate * 100).toFixed(0)}%
                      </span>
                    </div>

                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Consistency</span>
                      <span className="text-yellow-400 font-semibold">
                        {wallet.consistency.toFixed(0)}/100
                      </span>
                    </div>

                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Holdings</span>
                      <span className="text-cyan-400 font-semibold">{wallet.tokensHeld}</span>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="text-xs text-gray-500">
                    Last active: {new Date(wallet.updatedAt).toLocaleDateString()}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Featured Lists */}
      <div className="space-y-4 pt-4">
        <h3 className="text-xl font-semibold">Featured Lists</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            {
              title: '🔥 Top Gainers This Week',
              description: 'Wallets with highest realized gains in the last 7 days',
              icon: TrendingUp,
            },
            {
              title: '💎 Most Consistent Performers',
              description: 'High consistency score, reliable traders with stable returns',
              icon: TrendingUp,
            },
            {
              title: '📈 New to Top 100',
              description: 'Recently climbed the rankings, emerging smart money wallets',
              icon: TrendingUp,
            },
          ].map((list, i) => (
            <button
              key={i}
              className="card text-left hover:border-blue-500 transition-all duration-200 hover:shadow-lg hover:shadow-blue-500/10"
              onClick={() => setSelectedCategory('All')}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="text-2xl">{list.title.split(' ')[0]}</div>
                <ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-blue-400" />
              </div>

              <h4 className="font-semibold mb-2 text-sm">{list.title.slice(2)}</h4>
              <p className="text-sm text-gray-400">{list.description}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
