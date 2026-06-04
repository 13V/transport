'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { isValidPublicKey } from '@/lib/solana';
import SearchBar from '@/components/SearchBar';
import Link from 'next/link';
import { Zap } from 'lucide-react';

export default function Home() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (mint: string) => {
    setError(null);
    setLoading(true);

    // Validate
    if (!mint.trim()) {
      setError('Please enter a token address');
      setLoading(false);
      return;
    }

    if (!isValidPublicKey(mint)) {
      setError('Invalid Solana address format');
      setLoading(false);
      return;
    }

    try {
      // Navigate to report page
      router.push(`/token/${mint}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setLoading(false);
    }
  };

  return (
    <div className="space-y-12 py-12">
      {/* Hero */}
      <div className="text-center space-y-4">
        <h2 className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
          Detect Solana Insiders
        </h2>
        <p className="text-xl text-gray-400 max-w-2xl mx-auto">
          Identify creators, smart money wallets, early snipers, and bundle activity on any Solana token.
          Transparent, on-chain analysis to help you understand who's behind a token.
        </p>
      </div>

      {/* CTA Buttons */}
      <div className="flex flex-col sm:flex-row justify-center gap-4 max-w-2xl mx-auto">
        <div className="flex-1">
          <p className="text-sm text-gray-500 mb-2 font-semibold">Analyze a Token</p>
          <SearchBar onSearch={handleSearch} loading={loading} buttonText="Analyze Token" />
        </div>

        <div className="flex flex-col gap-2">
          <Link
            href="/smart-money"
            className="btn btn-primary text-center flex items-center justify-center gap-2 whitespace-nowrap"
          >
            <Zap className="w-5 h-5" />
            Smart Money Leaderboard
          </Link>
          <Link
            href="/smart-money/discovery"
            className="btn btn-secondary text-center whitespace-nowrap"
          >
            🔍 Discover Wallets
          </Link>
        </div>
      </div>

      {error && (
        <div className="max-w-2xl mx-auto p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200">
          {error}
        </div>
      )}

      {/* Features */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card space-y-2">
          <h3 className="text-lg font-semibold text-blue-400">👤 Creator Detection</h3>
          <p className="text-gray-400">
            Identify the token creator and wallets they directly funded right at launch.
          </p>
        </div>

        <div className="card space-y-2">
          <h3 className="text-lg font-semibold text-cyan-400">🔗 Cluster Analysis</h3>
          <p className="text-gray-400">
            Find wallet clusters sharing the same funding source, likely the same entity.
          </p>
        </div>

        <div className="card space-y-2">
          <h3 className="text-lg font-semibold text-green-400">⚡ Bundle Detection</h3>
          <p className="text-gray-400">
            Spot coordinated multi-wallet buys in the same block (typical of bundles & snipers).
          </p>
        </div>

        <div className="card space-y-2">
          <h3 className="text-lg font-semibold text-purple-400">💰 Smart Money Ranking</h3>
          <p className="text-gray-400">
            Rank wallets by realized PnL to surface consistent traders and insiders.
          </p>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-6 text-sm text-gray-300 space-y-2">
        <p className="font-semibold text-blue-300">📋 Disclaimer</p>
        <p>
          This tool is for educational and analytical purposes. Findings are based on heuristics applied to
          public on-chain data and may not be 100% accurate. Always DYOR before trading.
        </p>
      </div>
    </div>
  );
}
