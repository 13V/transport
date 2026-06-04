'use client';

import { ClusterGroup } from '@/lib/types';
import { formatAddress, formatNumber, formatPercent } from '@/lib/solana';

interface ClusterViewProps {
  clusters: ClusterGroup[];
}

export default function ClusterView({ clusters }: ClusterViewProps) {
  if (clusters.length === 0) {
    return (
      <div className="card">
        <p className="text-gray-400">No clusters detected</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {clusters.map((cluster, i) => (
        <div key={i} className="card space-y-4">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-sm text-gray-400">Funding Source</p>
              <p className="font-mono text-sm">{formatAddress(cluster.fundingSource)}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-400">Confidence</p>
              <p className="text-lg font-semibold text-blue-400">{formatPercent(cluster.confidence)}</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-gray-400">Wallets</p>
              <p className="text-lg font-semibold">{cluster.wallets.length}</p>
            </div>
            <div>
              <p className="text-sm text-gray-400">Total Holdings</p>
              <p className="text-lg font-semibold">{formatNumber(cluster.totalHoldings)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-400">Entity Size</p>
              <p className="text-lg font-semibold capitalize">{cluster.estimatedEntitySize}</p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold text-gray-300">Member Wallets</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {cluster.wallets.slice(0, 10).map((wallet, j) => (
                <div key={j} className="bg-gray-800 p-2 rounded font-mono text-xs">
                  {formatAddress(wallet)}
                </div>
              ))}
            </div>
            {cluster.wallets.length > 10 && (
              <p className="text-xs text-gray-500">+{cluster.wallets.length - 10} more wallets</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
