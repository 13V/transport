'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  ExternalLink,
  Loader,
  Copy,
  Check,
  ZoomOut,
} from 'lucide-react';
import {
  LineChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import CopyButton from './CopyButton';

interface WalletMetrics {
  smartMoneyScore: number;
  pnl: number;
  winRate: number;
  consistency: number;
  totalTrades: number;
  tokensHeld: number;
}

interface RecentActivity {
  lastActivityTime: string;
  averageHoldTime: number;
  tradingFrequency: number;
}

interface HistoricalRanking {
  date: string;
  rank: number | null;
  score: number;
}

interface WalletDetailsResponse {
  address: string;
  rank: number | null;
  rankScore: number;
  percentile: number;
  metrics: WalletMetrics;
  recentActivity: RecentActivity;
  historicalRanking: HistoricalRanking[];
}

type TradingStyle = 'Scalper' | 'Swing Trader' | 'Early Buyer' | 'Long-Term Holder';
type RiskLevel = 'Low' | 'Medium' | 'High';

interface WalletDetailProps {
  walletAddress: string;
}

export default function WalletDetail({ walletAddress }: WalletDetailProps) {
  const router = useRouter();
  const [wallet, setWallet] = useState<WalletDetailsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState({
    holdings: true,
    history: true,
    charts: true,
  });

  useEffect(() => {
    const fetchWalletDetails = async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/smart-money/${walletAddress}`);
        if (!response.ok) throw new Error('Failed to fetch wallet details');

        const data = (await response.json()) as WalletDetailsResponse;
        setWallet(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load wallet details');
      } finally {
        setLoading(false);
      }
    };

    fetchWalletDetails();
  }, [walletAddress]);

  const getTradingStyle = (metrics: WalletMetrics): TradingStyle => {
    const { winRate, totalTrades, averageHoldTime } = {
      winRate: metrics.winRate,
      totalTrades: metrics.totalTrades,
      averageHoldTime: 48, // Mock for demo
    };

    if (totalTrades > 100) return 'Scalper';
    if (totalTrades > 50) return 'Swing Trader';
    if (averageHoldTime < 24) return 'Early Buyer';
    return 'Long-Term Holder';
  };

  const getRiskLevel = (metrics: WalletMetrics): RiskLevel => {
    if (metrics.consistency < 40) return 'High';
    if (metrics.consistency < 70) return 'Medium';
    return 'Low';
  };

  const getScoreColor = (score: number) => {
    if (score >= 70) return 'text-green-400';
    if (score >= 30) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getRiskColor = (risk: RiskLevel) => {
    if (risk === 'Low') return 'text-green-400 bg-green-900/20';
    if (risk === 'Medium') return 'text-yellow-400 bg-yellow-900/20';
    return 'text-red-400 bg-red-900/20';
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-200 transition-colors mb-4"
        >
          <ArrowLeft className="w-5 h-5" />
          Back to leaderboard
        </button>
        <div className="text-center py-12">
          <Loader className="w-8 h-8 mx-auto animate-spin text-blue-400 mb-4" />
          <p className="text-gray-400">Loading wallet analysis...</p>
        </div>
      </div>
    );
  }

  if (error || !wallet) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-200 transition-colors mb-4"
        >
          <ArrowLeft className="w-5 h-5" />
          Back to leaderboard
        </button>
        <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200">
          {error || 'Wallet not found'}
        </div>
      </div>
    );
  }

  const tradingStyle = getTradingStyle(wallet.metrics);
  const riskLevel = getRiskLevel(wallet.metrics);

  return (
    <div className="space-y-6">
      {/* Back Button */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-gray-400 hover:text-gray-200 transition-colors"
      >
        <ArrowLeft className="w-5 h-5" />
        Back to leaderboard
      </button>

      {/* Header */}
      <div className="card space-y-4">
        <div className="flex flex-col gap-4">
          {/* Wallet Address */}
          <div>
            <p className="text-sm text-gray-400 mb-2">Wallet Address</p>
            <div className="flex items-center gap-3">
              <code className="text-lg bg-gray-800 px-4 py-2 rounded font-mono text-gray-200">
                {wallet.address}
              </code>
              <CopyButton text={wallet.address} label="wallet address" />
            </div>
          </div>

          {/* Score and Rank */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-gray-400 mb-1">Smart Money Score</p>
              <p className={`text-3xl font-bold ${getScoreColor(wallet.rankScore)}`}>
                {wallet.rankScore.toFixed(1)}
              </p>
            </div>

            {wallet.rank && (
              <div>
                <p className="text-sm text-gray-400 mb-1">Leaderboard Rank</p>
                <p className="text-3xl font-bold text-blue-400">#{wallet.rank}</p>
              </div>
            )}

            <div>
              <p className="text-sm text-gray-400 mb-1">Percentile Rank</p>
              <p className="text-3xl font-bold text-purple-400">{wallet.percentile}%</p>
            </div>
          </div>

          {/* Trading Style and Risk */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-gray-800">
            <div>
              <p className="text-sm text-gray-400 mb-2">Trading Style</p>
              <div className="inline-block px-4 py-2 rounded-full bg-blue-900/30 text-blue-300 font-semibold text-sm">
                {tradingStyle}
              </div>
            </div>

            <div>
              <p className="text-sm text-gray-400 mb-2">Risk Assessment</p>
              <div className={`inline-block px-4 py-2 rounded-full font-semibold text-sm ${getRiskColor(riskLevel)}`}>
                {riskLevel} Risk
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          {
            label: 'Realized PnL',
            value: `$${(wallet.metrics.pnl / 1000).toFixed(1)}k`,
            color: wallet.metrics.pnl >= 0 ? 'text-green-400' : 'text-red-400',
          },
          {
            label: 'Win Rate',
            value: `${(wallet.metrics.winRate * 100).toFixed(0)}%`,
            color: 'text-blue-400',
          },
          {
            label: 'Consistency',
            value: `${wallet.metrics.consistency.toFixed(0)}/100`,
            color: 'text-yellow-400',
          },
          {
            label: 'Total Trades',
            value: wallet.metrics.totalTrades.toString(),
            color: 'text-purple-400',
          },
          {
            label: 'Tokens Held',
            value: wallet.metrics.tokensHeld.toString(),
            color: 'text-cyan-400',
          },
          {
            label: 'Avg Hold Time',
            value: `${wallet.recentActivity.averageHoldTime}h`,
            color: 'text-orange-400',
          },
        ].map((metric) => (
          <div key={metric.label} className="card text-center space-y-2">
            <p className="text-xs text-gray-400 uppercase tracking-wider">{metric.label}</p>
            <p className={`text-xl font-bold ${metric.color}`}>{metric.value}</p>
          </div>
        ))}
      </div>

      {/* Charts Section */}
      {expandedSections.charts && wallet.historicalRanking.length > 0 && (
        <div className="card space-y-4">
          <div
            className="flex items-center justify-between cursor-pointer hover:text-blue-400 transition-colors"
            onClick={() =>
              setExpandedSections({
                ...expandedSections,
                charts: !expandedSections.charts,
              })
            }
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setExpandedSections({
                  ...expandedSections,
                  charts: !expandedSections.charts,
                });
              }
            }}
          >
            <h3 className="text-lg font-semibold">Score Trend (30 Days)</h3>
            <ZoomOut className="w-5 h-5" />
          </div>

          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={wallet.historicalRanking}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="date"
                  stroke="#888"
                  style={{ fontSize: '12px' }}
                  tick={{ fill: '#888' }}
                />
                <YAxis stroke="#888" style={{ fontSize: '12px' }} tick={{ fill: '#888' }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1a1a1a',
                    border: '1px solid #333',
                    borderRadius: '8px',
                  }}
                  formatter={(value) => [
                    typeof value === 'number' ? value.toFixed(1) : value,
                  ]}
                  labelStyle={{ color: '#888' }}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="text-xs text-gray-400 text-center pt-2">
            Smart money score tracking over the last 30 days
          </div>
        </div>
      )}

      {/* Recent Activity */}
      <div className="card space-y-4">
        <h3 className="text-lg font-semibold">Recent Activity</h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <p className="text-sm text-gray-400">Last Trade</p>
            <p className="text-lg font-semibold">
              {new Date(wallet.recentActivity.lastActivityTime).toLocaleDateString()}
            </p>
            <p className="text-xs text-gray-500">
              {new Date(wallet.recentActivity.lastActivityTime).toLocaleTimeString()}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-gray-400">Trading Frequency</p>
            <p className="text-lg font-semibold text-blue-400">
              {wallet.recentActivity.tradingFrequency.toFixed(2)}
            </p>
            <p className="text-xs text-gray-500">trades per week</p>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-gray-400">Average Hold Time</p>
            <p className="text-lg font-semibold text-green-400">
              {wallet.recentActivity.averageHoldTime}h
            </p>
            <p className="text-xs text-gray-500">hours</p>
          </div>
        </div>
      </div>

      {/* External Links */}
      <div className="card space-y-4">
        <h3 className="text-lg font-semibold mb-4">View on Explorer</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            {
              name: 'Solscan',
              icon: '🔍',
              url: `https://solscan.io/address/${wallet.address}`,
            },
            {
              name: 'Magic Eden Creator',
              icon: '✨',
              url: `https://magiceden.io/creators/${wallet.address}`,
            },
            {
              name: 'DEXScreener',
              icon: '📊',
              url: `https://dexscreener.com/solana/${wallet.address}`,
            },
            {
              name: 'Birdeye',
              icon: '🦅',
              url: `https://birdeye.so/wallet/${wallet.address}`,
            },
          ].map((link) => (
            <a
              key={link.name}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 p-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-blue-400 hover:text-blue-300 transition-colors"
            >
              <span className="text-lg">{link.icon}</span>
              <span className="font-medium">{link.name}</span>
              <ExternalLink className="w-4 h-4 ml-auto" />
            </a>
          ))}
        </div>
      </div>

      {/* Disclaimer */}
      <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-4 text-xs text-gray-300">
        <p className="font-semibold text-blue-300 mb-1">📋 Data Disclaimer</p>
        <p>
          Wallet analysis is based on on-chain transaction data. Scores are calculated using
          heuristics and may not be 100% accurate. Always conduct your own research (DYOR) before
          trading.
        </p>
      </div>
    </div>
  );
}
