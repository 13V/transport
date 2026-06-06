/* =========================================================================
   CHARTS — crisp hand-built SVG, ported from the design prototype (charts.js).
   Dependency-free, render anywhere (server or client). Gradient ids are
   derived deterministically from the data so SSR/CSR markup matches.
   ========================================================================= */
import React from 'react';

export const CHART_COLORS = { ACCENT: '#6D76F5', POS: '#34D399', NEG: '#FB7185' };

function hashId(prefix: string, values: number[]): string {
  let h = 0;
  for (let i = 0; i < values.length; i++) {
    h = (Math.imul(31, h) + Math.round((values[i] ?? 0) * 100)) | 0;
  }
  return `${prefix}${(h >>> 0).toString(36)}`;
}

// smooth path via Catmull-Rom → cubic bezier
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

interface AreaChartProps {
  values: number[];
  height?: number;
  color?: string;
  xLabels?: string[];
  fmtY?: (v: number) => string | number;
}

export function AreaChart({ values, height = 220, color = CHART_COLORS.ACCENT, xLabels, fmtY }: AreaChartProps) {
  const w = 720;
  const h = height;
  const pad = { t: 16, r: 16, b: 26, l: 44 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const id = hashId('a', values);

  if (values.length < 2) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} />;

  const min = Math.min(0, ...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => pad.l + (i / (values.length - 1)) * iw;
  const y = (v: number) => pad.t + ih - ((v - min) / span) * ih;

  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const line = smoothPath(pts);
  const area = `${line} L ${x(values.length - 1)} ${pad.t + ih} L ${x(0)} ${pad.t + ih} Z`;

  const ticks = 4;
  const grid: React.ReactNode[] = [];
  for (let i = 0; i <= ticks; i++) {
    const gy = pad.t + (ih / ticks) * i;
    const val = max - (span / ticks) * i;
    grid.push(<line key={`g${i}`} x1={pad.l} y1={gy} x2={w - pad.r} y2={gy} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />);
    grid.push(
      <text key={`l${i}`} x={pad.l - 8} y={gy + 3.5} textAnchor="end" fontSize="10.5" fill="#6A7184" fontFamily="ui-monospace,monospace">
        {fmtY ? fmtY(val) : Math.round(val)}
      </text>
    );
  }
  const xlabels: React.ReactNode[] = [];
  if (xLabels && xLabels.length) {
    const n = xLabels.length;
    xLabels.forEach((lb, i) => {
      const idx = Math.round((i / (n - 1)) * (values.length - 1));
      xlabels.push(
        <text key={`x${i}`} x={x(idx)} y={h - 8} textAnchor="middle" fontSize="10.5" fill="#6A7184" fontFamily="ui-monospace,monospace">
          {lb}
        </text>
      );
    });
  }
  const last = pts[pts.length - 1];

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid}
      {xlabels}
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={3.5} fill={color} />
      <circle cx={last[0]} cy={last[1]} r={6.5} fill={color} opacity={0.18} />
    </svg>
  );
}

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}

export function Sparkline({ values, width = 96, height = 28, color = CHART_COLORS.ACCENT }: SparklineProps) {
  const w = width;
  const h = height;
  const id = hashId('s', values);
  if (values.length < 2) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const x = (i: number) => pad + (i / (values.length - 1)) * (w - pad * 2);
  const y = (v: number) => pad + (h - pad * 2) - ((v - min) / span) * (h - pad * 2);
  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  const line = smoothPath(pts);
  const area = `${line} L ${x(values.length - 1)} ${h} L ${x(0)} ${h} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={1.9} fill={color} />
    </svg>
  );
}

interface BarsProps {
  values: number[];
  width?: number;
  height?: number;
  highlight?: number;
  labels?: string[];
}

export function Bars({ values, width = 340, height = 150, highlight, labels }: BarsProps) {
  const w = width;
  const h = height;
  const pad = { t: 10, r: 4, b: labels ? 22 : 6, l: 4 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const max = Math.max(...values) || 1;
  const n = values.length;
  const gap = 4;
  const bw = (iw - gap * (n - 1)) / n;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width="100%" height={h}>
      {values.map((v, i) => {
        const bh = Math.max(2, (v / max) * ih);
        const bx = pad.l + i * (bw + gap);
        const by = pad.t + ih - bh;
        const hot = highlight != null && i === highlight;
        return <rect key={i} x={bx} y={by} width={bw} height={bh} rx={2.5} fill={hot ? CHART_COLORS.ACCENT : 'rgba(109,118,245,0.32)'} />;
      })}
      {labels?.map((lb, i) => (
        <text key={`t${i}`} x={pad.l + i * (bw + gap) + bw / 2} y={h - 7} textAnchor="middle" fontSize="9.5" fill="#6A7184" fontFamily="ui-monospace,monospace">
          {lb}
        </text>
      ))}
    </svg>
  );
}
