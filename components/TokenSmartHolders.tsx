'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { Loader } from 'lucide-react';
import CopyButton from './CopyButton';

interface SmartHolder {
  wallet: string;
  allTimeRoiPct: number | null;
  verified: boolean;
  pnlOnThisCoin: number;
  tokensRemaining: number;
  buys: number;
  sells: number;
}

interface SmartHoldersResponse {
  mint: string;
  traderCount: number;
  smartHolderCount: number;
  smartHolders: SmartHolder[];
}

interface TokenSmartHoldersProps {
  mint: string;
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

export default function TokenSmartHolders({ mint }: TokenSmartHoldersProps) {
  const [data, setData] = useState<SmartHoldersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/token/${mint}/smart-holders`);
      if (!res.ok) {
        let message = 'Scan failed';
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // ignore JSON parse failures, keep default message
        }
        throw new Error(message);
      }
      const json = (await res.json()) as SmartHoldersResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setLoading(false);
    }
  }, [mint]);

  return (
    <div className="card space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">🧠 Smart money in this coin</h2>
          <p className="text-sm text-gray-400">
            Verified smart wallets among this coin&apos;s recent traders.
          </p>
        </div>
        <button
          onClick={scan}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white text-sm font-medium transition-colors whitespace-nowrap"
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <Loader className="w-4 h-4 animate-spin" />
              Scanning on-chain, ~30s
            </span>
          ) : data ? (
            'Re-scan smart holders'
          ) : (
            'Scan smart holders'
          )}
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200 text-sm">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-center py-10 text-gray-400">
          <Loader className="w-8 h-8 mx-auto animate-spin text-blue-400 mb-3" />
          <p>Scanning on-chain, ~30s…</p>
        </div>
      )}

      {data && (
        <div className="space-y-4">
          <p className="text-sm text-gray-300">
            <span className="font-bold text-emerald-400">{data.smartHolderCount}</span> of{' '}
            <span className="font-bold">{data.traderCount}</span> traders are verified smart
            money
          </p>

          {data.smartHolders.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">
              No verified smart wallets found in this coin&apos;s recent trades.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-gray-300">
                    <th className="px-4 py-3 font-semibold">Wallet</th>
                    <th className="px-4 py-3 font-semibold text-right">ROI (all-time)</th>
                    <th className="px-4 py-3 font-semibold text-right">PnL on this coin</th>
                    <th className="px-4 py-3 font-semibold text-right">Buys / Sells</th>
                    <th className="px-4 py-3 font-semibold text-right">Holding</th>
                  </tr>
                </thead>
                <tbody>
                  {data.smartHolders.map((holder) => (
                    <tr
                      key={holder.wallet}
                      className="table-row border-b border-gray-800/50 hover:bg-gray-800/50"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/smart-money/${holder.wallet}`}
                            className="text-xs bg-gray-800 px-2 py-1 rounded text-blue-400 hover:text-blue-300 font-mono"
                            title="View wallet analysis"
                          >
                            {shortWallet(holder.wallet)}
                          </Link>
                          {holder.verified && (
                            <span
                              className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 ring-1 ring-emerald-500/30"
                              title="Verified smart money"
                            >
                              ✓ Smart
                            </span>
                          )}
                          <CopyButton text={holder.wallet} label="wallet address" />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {holder.allTimeRoiPct == null ? (
                          <span className="text-gray-600">—</span>
                        ) : (
                          <span
                            className={`font-bold ${
                              holder.allTimeRoiPct >= 0 ? 'text-green-400' : 'text-red-400'
                            }`}
                          >
                            {holder.allTimeRoiPct >= 0 ? '+' : ''}
                            {holder.allTimeRoiPct.toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={`font-semibold ${
                            holder.pnlOnThisCoin >= 0 ? 'text-green-400' : 'text-red-400'
                          }`}
                        >
                          {holder.pnlOnThisCoin >= 0 ? '+' : ''}
                          {holder.pnlOnThisCoin.toFixed(2)} SOL
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-300">
                        <span className="text-green-400">{holder.buys}</span>
                        {' / '}
                        <span className="text-red-400">{holder.sells}</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {holder.tokensRemaining > 0 ? (
                          <span
                            className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400 ring-1 ring-amber-500/30"
                            title="Still holding tokens"
                          >
                            holding
                          </span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
