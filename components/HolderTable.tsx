'use client';

import { HolderInfo } from '@/lib/types';
import { formatAddress, formatNumber, formatPercent } from '@/lib/solana';

interface HolderTableProps {
  holders: HolderInfo[];
}

export default function HolderTable({ holders }: HolderTableProps) {
  return (
    <div className="card overflow-x-auto">
      <h3 className="text-lg font-semibold mb-4">Top Holders</h3>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-700 text-gray-400">
          <tr>
            <th className="text-left py-3 px-2">Address</th>
            <th className="text-right py-3 px-2">Amount</th>
            <th className="text-right py-3 px-2">% Supply</th>
            <th className="text-center py-3 px-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {holders.map((holder, i) => (
            <tr key={i} className="table-row">
              <td className="py-3 px-2 font-mono text-xs">{formatAddress(holder.address)}</td>
              <td className="py-3 px-2 text-right">{formatNumber(holder.amount)}</td>
              <td className="py-3 px-2 text-right">{formatPercent(holder.percentOfSupply)}</td>
              <td className="py-3 px-2 text-center">
                {holder.isCreator && <span className="badge badge-danger">Creator</span>}
                {holder.isEarlyBuyer && <span className="badge badge-warning">Early</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
