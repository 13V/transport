'use client';

import { useState, useEffect } from 'react';
import { TrendingUp } from 'lucide-react';
import * as f from '@/lib/format';
import {
  AreaChart, CHART_COLORS, EmptyState, ErrorState, SkLine,
} from '@/components/ui';

/**
 * WALLET HISTORY CHART
 *
 * Fetches the wallet's daily leaderboard snapshots from
 * /api/wallet/{address}/history and charts ROI% (or realized PnL) over time
 * inside the premium-analytics card shell. The metric (ROI/PnL) and range
 * (30D/90D/All) toggles are local client state; the data fetch is preserved
 * from the original implementation.
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

type Metric = 'roiPct' | 'pnl';
type Range = 30 | 90 | 9999;

const RANGES: [Range, string][] = [
  [30, '30D'],
  [90, '90D'],
  [9999, 'All'],
];
const METRICS: [Metric, string][] = [
  ['roiPct', 'ROI %'],
  ['pnl', 'PnL'],
];

function Shell({ children, controls }: { children: React.ReactNode; controls?: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3><span className="ic"><TrendingUp size={16} /></span> Performance history</h3>
        {controls}
      </div>
      <div className="card-pad">{children}</div>
    </div>
  );
}

export default function WalletHistoryChart({ walletAddress }: WalletHistoryChartProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>('roiPct');
  const [range, setRange] = useState<Range>(90);

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

  const controls = (
    <div className="row gap-8">
      <div className="seg">
        {METRICS.map(([v, l]) => (
          <button key={v} className={metric === v ? 'on' : ''} onClick={() => setMetric(v)}>{l}</button>
        ))}
      </div>
      <div className="seg">
        {RANGES.map(([v, l]) => (
          <button key={v} className={range === v ? 'on' : ''} onClick={() => setRange(v)}>{l}</button>
        ))}
      </div>
    </div>
  );

  if (loading) {
    return <Shell controls={controls}><SkLine w="100%" h={230} /></Shell>;
  }

  if (error) {
    return <Shell controls={controls}><ErrorState msg={error} /></Shell>;
  }

  const all = snapshots ?? [];
  // Range filter: keep the most recent `range` days (9999 = all).
  const windowed = range >= 9999 ? all : all.slice(-range);

  if (windowed.length < 2) {
    return (
      <Shell controls={controls}>
        <EmptyState
          icon={TrendingUp}
          title="Not enough history yet"
          msg="Daily snapshots build this trajectory over time."
        />
      </Shell>
    );
  }

  // Map snapshots to the active metric, coercing nulls to 0 so the curve is continuous.
  // TODO(chart): coercing missing days to 0 fabricates dips toward zero ROI. Once
  // AreaChart can skip/interpolate null points without breaking, drop the `?? 0`
  // and plot gaps as missing instead of as real 0 values.
  const vals = windowed.map((p) =>
    metric === 'roiPct' ? (p.roiPct ?? 0) : (p.realizedPnl ?? 0)
  );

  // ~5 evenly-spaced date labels.
  const step = Math.max(1, Math.ceil(windowed.length / 5));
  const xLabels = windowed
    .filter((_, i) => i % step === 0)
    .map((p) => f.date(+new Date(p.day)));

  const last = vals[vals.length - 1];
  const first = vals[0];
  const up = last >= first;
  const color = up ? CHART_COLORS.POS : CHART_COLORS.NEG;

  return (
    <Shell controls={controls}>
      <div className="row gap-16" style={{ marginBottom: 6 }}>
        <div className="stack">
          <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>
            Current {metric === 'roiPct' ? 'ROI' : 'PnL'}
          </span>
          <span className={`num ${up ? 'pos' : 'neg'}`} style={{ fontSize: 22, fontWeight: 660 }}>
            {metric === 'roiPct' ? f.pct(last) : `${f.solSigned(last)} SOL`}
          </span>
        </div>
        <div className="chart-legend" style={{ marginLeft: 'auto' }}>
          <span className="lg"><span className="sw" style={{ background: color }} />{metric === 'roiPct' ? 'All-time ROI' : 'Realized PnL'}</span>
        </div>
      </div>
      <AreaChart
        values={vals}
        height={230}
        color={color}
        xLabels={xLabels}
        fmtY={(v) => (metric === 'roiPct' ? `${Math.round(Number(v))}%` : Math.round(Number(v)))}
      />
    </Shell>
  );
}
