'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Star, Copy, Check, Loader, ExternalLink } from 'lucide-react';
import { useWatchlist } from '@/lib/useWatchlist';

interface ListWallet {
  address: string;
  score: number;
  pnl: number;
  roiPct: number | null;
  verified?: boolean;
  winRate?: number;
  tier?: string;
}

interface ListResponse {
  count: number;
  wallets: ListWallet[];
}

function tierColor(tier?: string): string {
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
}

export default function WatchlistView() {
  const { watchlist, isWatched, toggle } = useWatchlist();
  const [wallets, setWallets] = useState<ListWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Fetch the curated list once; we filter it down to watched addresses below.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/smart-money/list?limit=1000');
        if (!res.ok) throw new Error('Failed to load wallet list');
        const json = (await res.json()) as ListResponse;
        if (active) setWallets(json.wallets ?? []);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load wallet list');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Watched wallets enriched with stats from the list. Wallets in the watchlist
  // that aren't in the curated list still show up (address only).
  const rows = useMemo(() => {
    const byAddress = new Map(wallets.map((w) => [w.address, w]));
    return watchlist.map(
      (address) => byAddress.get(address) ?? ({ address, score: 0, pnl: 0, roiPct: null } as ListWallet)
    );
  }, [watchlist, wallets]);

  const copyAddresses = async () => {
    try {
      await navigator.clipboard.writeText(watchlist.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
  };

  if (watchlist.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-3xl font-bold">Your Watchlist</h2>
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-10 text-center">
          <Star className="mx-auto mb-4 h-10 w-10 text-gray-600" />
          <p className="text-gray-300 font-medium">Your watchlist is empty.</p>
          <p className="mt-1 text-sm text-gray-500">
            Star wallets on the leaderboard to keep an eye on them here.
          </p>
          <Link
            href="/smart-money"
            className="mt-6 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Browse Smart Money
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-3xl font-bold">Your Watchlist</h2>
          <p className="text-gray-400">
            {watchlist.length} wallet{watchlist.length !== 1 ? 's' : ''} you&apos;re tracking
          </p>
        </div>
        <button
          onClick={copyAddresses}
          className="inline-flex items-center gap-1.5 self-start rounded-lg bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-400 ring-1 ring-emerald-500/30 transition-colors hover:bg-emerald-500/20"
          title="Copy all watchlist addresses to the clipboard"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied!' : 'Copy watchlist addresses'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center">
          <Loader className="mx-auto mb-4 h-8 w-8 animate-spin text-blue-400" />
          <p className="text-gray-400">Loading watchlist stats...</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-gray-300">
                <th className="px-4 py-3 font-semibold">Wallet Address</th>
                <th className="px-4 py-3 font-semibold text-right">ROI</th>
                <th className="px-4 py-3 font-semibold text-right">PnL</th>
                <th className="px-4 py-3 font-semibold">Tier</th>
                <th className="px-4 py-3 font-semibold text-right">Watch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((wallet) => (
                <tr key={wallet.address} className="border-b border-gray-800/60 hover:bg-gray-800/50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/smart-money/${wallet.address}`}
                      className="inline-flex items-center gap-1.5 text-blue-400 hover:text-blue-300"
                    >
                      <code className="rounded bg-gray-800 px-2 py-1 font-mono text-xs text-gray-300">
                        {wallet.address.slice(0, 8)}...{wallet.address.slice(-4)}
                      </code>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {wallet.roiPct == null ? (
                      <span className="text-gray-600">—</span>
                    ) : (
                      <span
                        className={`font-bold ${wallet.roiPct >= 0 ? 'text-green-400' : 'text-red-400'}`}
                      >
                        {wallet.roiPct >= 0 ? '+' : ''}
                        {wallet.roiPct.toFixed(1)}%
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={wallet.pnl >= 0 ? 'font-semibold text-green-400' : 'text-red-400'}>
                      {wallet.pnl >= 0 ? '+' : ''}
                      {wallet.pnl.toFixed(2)} SOL
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {wallet.tier ? (
                      <span
                        className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${tierColor(
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
                    <button
                      onClick={() => toggle(wallet.address)}
                      className={`rounded p-1 transition-colors hover:bg-gray-700 ${
                        isWatched(wallet.address) ? 'text-amber-400' : 'text-gray-500'
                      }`}
                      title="Remove from watchlist"
                      aria-label="Remove from watchlist"
                    >
                      <Star className="h-4 w-4" fill={isWatched(wallet.address) ? 'currentColor' : 'none'} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
