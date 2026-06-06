'use client';

import { useState, useEffect } from 'react';
import { Loader } from 'lucide-react';
import {
  LineChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

/**
 * WALLET HISTORY CHART
 *
 * Fetches the wallet's daily leaderboard snapshots from
 * /api/wallet/{address}/history and charts ROI% (and realized PnL on a second
 * axis) over time. Degrades gracefully: while loading it shows a spinner, and
 * when fewer than two snapshots exist it shows a subtle "not enough history"
 * note rather than erroring.
 */

interface Snapshot {
  day: string;
  rank: number | null;
  score: number | null;
  roiPct: number | null;
  realizedPnl: number | null;
}

interface HistoryResponse {
  address?: string;
  snapshots?: Snapshot[];
}

interface WalletHistoryChartProps {
  walletAddress: string;
}

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-6">
    <h3 className="text-lg font-semibold mb-4">ROI history</h3>
    {children}
  </div>
);

export default function WalletHistoryChart({ walletAddress }: WalletHistoryChartProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/wallet/${walletAddress}/history`);
        if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
        const json = (await res.json()) as HistoryResponse;
        if (!cancelled) {
          setSnapshots(Array.isArray(json.snapshots) ? json.snapshots : []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load wallet history');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader className="w-4 h-4 animate-spin text-blue-400" />
          Loading ROI history…
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <p className="text-sm text-gray-500">{error}</p>
      </Card>
    );
  }

  const data = snapshots ?? [];

  if (data.length < 2) {
    return (
      <Card>
        <p className="text-sm text-gray-500">
          Not enough history yet — daily snapshots build this over time.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="day"
              stroke="#9ca3af"
              style={{ fontSize: '12px' }}
              tick={{ fill: '#9ca3af' }}
            />
            <YAxis
              yAxisId="roi"
              stroke="#9ca3af"
              style={{ fontSize: '12px' }}
              tick={{ fill: '#9ca3af' }}
              tickFormatter={(v) => `${v}%`}
            />
            <YAxis
              yAxisId="pnl"
              orientation="right"
              stroke="#9ca3af"
              style={{ fontSize: '12px' }}
              tick={{ fill: '#9ca3af' }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1a1a1a',
                border: '1px solid #1f2937',
                borderRadius: '8px',
              }}
              labelStyle={{ color: '#9ca3af' }}
              labelFormatter={(label) => `Day: ${label}`}
              formatter={(value, name) => {
                const num = typeof value === 'number' ? value : Number(value);
                if (name === 'ROI%') {
                  return [Number.isFinite(num) ? `${num.toFixed(1)}%` : '—', 'ROI'];
                }
                return [Number.isFinite(num) ? `${num.toFixed(3)} SOL` : '—', 'Realized PnL'];
              }}
            />
            <Line
              yAxisId="roi"
              type="monotone"
              dataKey="roiPct"
              name="ROI%"
              stroke="#10b981"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              yAxisId="pnl"
              type="monotone"
              dataKey="realizedPnl"
              name="Realized PnL"
              stroke="#3b82f6"
              strokeWidth={1.5}
              strokeDasharray="4 2"
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
