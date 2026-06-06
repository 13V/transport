/* =========================================================================
   UI PRIMITIVES — pure/presentational, ported from the design prototype
   (ui.js). Server-safe (no client hooks). Interactive bits live in
   ./interactive.tsx. Use the './ui' barrel to import.
   ========================================================================= */
import React from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import * as f from '@/lib/format';

export type Tier = 'S' | 'A' | 'B' | 'C';

export function TierBadge({ tier, lg }: { tier?: string | null; lg?: boolean }) {
  if (!tier) return <span className="faint">—</span>;
  return (
    <span className={`tier tier-${tier}${lg ? ' lg' : ''}`} title={`Tier ${tier}`}>
      {tier}
    </span>
  );
}

export function Roi({ value, d = 1 }: { value?: number | null; d?: number }) {
  if (value == null || !Number.isFinite(value)) return <span className="faint" title="Not deep-scanned yet">—</span>;
  return (
    <span className={`num ${value >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 650 }}>
      {f.pct(value, d)}
    </span>
  );
}

export function Pnl({ value, unit = true }: { value?: number | null; unit?: boolean }) {
  if (value == null || !Number.isFinite(value)) return <span className="faint">—</span>;
  return (
    <span className={`num ${value >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 600 }}>
      {f.solSigned(value)}
      {unit && <span className="faint" style={{ fontWeight: 500 }}> SOL</span>}
    </span>
  );
}

export function WinBar({ value }: { value?: number | null }) {
  if (value == null || !Number.isFinite(value)) return <span className="faint">—</span>;
  const w = Math.max(0, Math.min(1, value));
  return (
    <span className="metricw">
      <span className="bar pos"><i style={{ width: `${(w * 100).toFixed(0)}%` }} /></span>
      <span className="mv faint">{Math.round(w * 100)}%</span>
    </span>
  );
}

const TOKEN_HUES = [248, 161, 14, 286, 200, 36, 330, 96, 268, 178];
export function TokenMark({ symbol, size = 26 }: { symbol?: string; size?: number }) {
  const s = symbol || '?';
  const h = TOKEN_HUES[(s.charCodeAt(0) || 0) % TOKEN_HUES.length];
  const r = Math.round(size * 0.3);
  return (
    <span
      style={{
        display: 'inline-grid', placeItems: 'center', width: size, height: size,
        borderRadius: r, background: `hsl(${h} 32% 17%)`, color: `hsl(${h} 64% 66%)`,
        border: `1px solid hsl(${h} 34% 28%)`, fontSize: Math.round(size * 0.42),
        fontWeight: 700, flexShrink: 0, fontFamily: 'var(--font-mono)',
      }}
    >
      {s.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function SourceBadge({ source }: { source: string }) {
  const s = source || '';
  const label = s === 'BONDING_CURVE' ? 'Bonding' : s ? s.charAt(0) + s.slice(1).toLowerCase() : '—';
  return <span className="badge tag">{label}</span>;
}

export function EmptyState({
  icon: Icon = Inbox, title, msg, action, actionHref,
}: {
  icon?: LucideIcon; title: string; msg?: string; action?: string; actionHref?: string;
}) {
  return (
    <div className="placeholder">
      <div className="ph-ic"><Icon size={22} /></div>
      <h4>{title}</h4>
      {msg && <p>{msg}</p>}
      {action && actionHref && (
        <Link className="btn primary sm" href={actionHref}>{action}</Link>
      )}
    </div>
  );
}

/* ---- skeletons --------------------------------------------------------- */
export function SkLine({ w = '100%', h }: { w?: string; h?: number }) {
  return <div className="sk sk-line" style={{ width: w, ...(h ? { height: h } : {}) }} />;
}

export function SkTable({ cols, rows = 8 }: { cols: number; rows?: number }) {
  return (
    <div className="card">
      <div className="table-wrap">
        <table className="dt">
          <tbody>
            {Array.from({ length: rows }).map((_, i) => (
              <tr className="sk-row" key={i}>
                {Array.from({ length: cols }).map((_, c) => {
                  const w = c === 0 ? '60%' : c === 1 ? '78%' : `${40 + ((i * 7 + c * 11) % 40)}%`;
                  return <td key={c}><SkLine w={w} /></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SkStat() {
  return (
    <div className="stat">
      <div className="stat-label"><SkLine w="70px" /></div>
      <div style={{ marginTop: 14 }}><SkLine w="110px" h={26} /></div>
      <div style={{ marginTop: 12 }}><SkLine w="80px" /></div>
    </div>
  );
}

export function SkCard({ h = 120 }: { h?: number }) {
  return (
    <div className="card card-pad">
      <div className="stack gap-12"><SkLine w="40%" /><SkLine w="100%" h={h} /></div>
    </div>
  );
}
