'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader, ExternalLink } from 'lucide-react';
import CopyButton from './CopyButton';

interface SmartBuyToken {
  mint: string;
  distinctSmartBuyers: number;
  buys: number;
  solVolume: number;
  firstBuy: string | null;
  lastBuy: string | null;
  sampleBuyers: string[];
}

interface SmartMoneyBuysResponse {
  generatedAt: string;
  hours: number;
  count: number;
  tokens: SmartBuyToken[];
}

type Window = 6 | 24 | 72;

const WINDOWS: Window[] = [6, 24, 72];
const AUTO_REFRESH_MS = 2 * 60 * 1000;

// Compact relative time, e.g. "3m ago", "2h ago", "1d ago".
function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export default function SmartMoneyBuying() {
  const [data, setData] = useState<SmartBuyToken[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string>('');
  const [hours, setHours] = useState<Window>(24);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBuys = useCallback(async (window: Window) => {
    try {
      setRefreshing(true);
      const response = await fetch(
        `/api/smart-money/buying?hours=${window}&limit=50`
      );
      if (!response.ok) throw new Error('Failed to fetch smart money buys');

      const json = (await response.json()) as SmartMoneyBuysResponse;
      setData(json.tokens);
      setGeneratedAt(json.generatedAt);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load smart money buys');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial fetch + refetch whenever the time window changes.
  useEffect(() => {
    fetchBuys(hours);
  }, [fetchBuys, hours]);

  // Auto-refresh every 2 minutes for the current window.
  useEffect(() => {
    const interval = setInterval(() => fetchBuys(hours), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchBuys, hours]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="text-center py-12">
          <Loader className="w-8 h-8 mx-auto animate-spin text-blue-400 mb-4" />
          <p className="text-gray-400">Loading smart money buys...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h2 className="text-3xl font-bold">What smart money is buying</h2>
        <p className="text-gray-400">
          Tokens that multiple verified smart wallets bought recently — a
          &ldquo;smart money is rotating into X&rdquo; signal.
          {generatedAt && (
            <span className="text-xs text-gray-500 ml-2">
              (Updated: {new Date(generatedAt).toLocaleTimeString()})
            </span>
          )}
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex gap-2 items-center">
          <span className="text-sm text-gray-400">Window:</span>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setHours(w)}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                hours === w
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
              aria-pressed={hours === w}
            >
              {w}h
            </button>
          ))}
        </div>

        <button
          onClick={() => fetchBuys(hours)}
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

      {error && (
        <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-gray-300">
              <th className="px-4 py-3 font-semibold">Rank</th>
              <th className="px-4 py-3 font-semibold">Token</th>
              <th className="px-4 py-3 font-semibold text-right">Smart buyers</th>
              <th className="px-4 py-3 font-semibold text-right">Buys</th>
              <th className="px-4 py-3 font-semibold text-right">SOL volume</th>
              <th className="hidden sm:table-cell px-4 py-3 font-semibold text-right">
                Last buy
              </th>
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  No smart money buys in the last {hours}h.
                </td>
              </tr>
            ) : (
              data.map((token, i) => (
                <tr key={token.mint} className="table-row hover:bg-gray-800/50">
                  <td className="px-4 py-3 font-bold text-gray-300">#{i + 1}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <code className="text-xs bg-gray-800 px-2 py-1 rounded text-gray-300 font-mono">
                        {token.mint.slice(0, 8)}...{token.mint.slice(-4)}
                      </code>
                      <CopyButton text={token.mint} label="token mint" />
                      <a
                        href={`/token/${token.mint}`}
                        className="p-1 hover:bg-gray-700 rounded transition-colors text-blue-400"
                        title="View token page"
                        aria-label={`View token ${token.mint}`}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                      <a
                        href={`https://dexscreener.com/solana/${token.mint}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 hover:bg-gray-700 rounded transition-colors text-green-400"
                        title="View on DEXScreener"
                        aria-label={`View ${token.mint} on DEXScreener`}
                      >
                        📊
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-block px-3 py-1 rounded-full text-sm font-bold text-emerald-400 bg-emerald-900/20">
                      {token.distinctSmartBuyers}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-300">{token.buys}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-200">
                    {token.solVolume.toFixed(2)} SOL
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3 text-right text-gray-400 text-xs">
                    {relativeTime(token.lastBuy)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer Info */}
      <div className="text-xs text-gray-500 text-center py-4 border-t border-gray-800">
        <p>Ranked by distinct verified smart wallets buying. Auto-refreshes every 2 minutes.</p>
      </div>
    </div>
  );
}
