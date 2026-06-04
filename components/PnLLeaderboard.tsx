'use client';

import { SmartMoneyWallet } from '@/lib/types';
import { formatAddress, formatNumber, formatPercent } from '@/lib/solana';

interface PnLLeaderboardProps {
  wallets: SmartMoneyWallet[];
}

export default function PnLLeaderboard({ wallets }: PnLLeaderboardProps) {
  if (wallets.length === 0) {
    return (
      <div className="card">
        <p className="text-gray-400">No smart money wallets detected</p>
      </div>
    );
  }

  return (
    <div className="card overflow-x-auto">
      <h3 className="text-lg font-semibold mb-4">💰 Smart Money Wallets (By PnL)</h3>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-700 text-gray-400">
          <tr>
            <th className="text-left py-3 px-2">Rank</th>
            <th className="text-left py-3 px-2">Address</th>
            <th className="text-right py-3 px-2">Realized PnL</th>
            <th className="text-right py-3 px-2">Win Rate</th>
            <th className="text-right py-3 px-2">Trades</th>
          </tr>
        </thead>
        <tbody>
          {wallets.map((wallet, i) => (
            <tr key={i} className="table-row">
              <td className="py-3 px-2 font-bold text-lg">{i + 1}</td>
              <td className="py-3 px-2 font-mono text-xs">{formatAddress(wallet.address)}</td>
              <td className={`py-3 px-2 text-right font-semibold ${
                wallet.realizedPnL > 0 ? 'text-green-400' : 'text-red-400'
              }`}>
                {wallet.realizedPnL > 0 ? '+' : ''}{formatNumber(wallet.realizedPnL, 2)} SOL
              </td>
              <td className="py-3 px-2 text-right">{formatPercent(wallet.winRate)}</td>
              <td className="py-3 px-2 text-right">{wallet.totalTrades}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
