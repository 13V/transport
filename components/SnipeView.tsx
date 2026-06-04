'use client';

import { SnipeBundle } from '@/lib/types';
import { formatAddress, formatNumber, formatPercent } from '@/lib/solana';

interface SnipeViewProps {
  snipers: SnipeBundle[];
}

export default function SnipeView({ snipers }: SnipeViewProps) {
  if (snipers.length === 0) {
    return (
      <div className="card">
        <p className="text-gray-400">No snipers/bundles detected</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {snipers.slice(0, 20).map((snipe, i) => (
        <div key={i} className="card space-y-3">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-sm text-gray-400">Slot {snipe.slot}</p>
              <p className="text-xs text-gray-500">{new Date(snipe.timestamp * 1000).toLocaleString()}</p>
            </div>
            <span className="badge badge-warning">{formatPercent(snipe.confidence)} confidence</span>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-gray-400">Wallets</p>
              <p className="text-lg font-semibold">{snipe.wallets.length}</p>
            </div>
            <div>
              <p className="text-sm text-gray-400">Amount Each</p>
              <p className="text-lg font-semibold">{formatNumber(snipe.amountPerWallet)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-400">Total</p>
              <p className="text-lg font-semibold">{formatNumber(snipe.amountPerWallet * snipe.wallets.length)}</p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold text-gray-300">Participating Wallets</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {snipe.wallets.slice(0, 8).map((wallet, j) => (
                <div key={j} className="bg-gray-800 p-2 rounded font-mono text-xs">
                  {formatAddress(wallet)}
                </div>
              ))}
            </div>
            {snipe.wallets.length > 8 && (
              <p className="text-xs text-gray-500">+{snipe.wallets.length - 8} more wallets</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
