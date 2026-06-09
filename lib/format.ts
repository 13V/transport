/* =========================================================================
   Shared figure formatters — ported from the design handoff (prototype/data.js).
   Tabular, terse, Solana-flavoured. Used across every redesigned screen.
   ========================================================================= */

function round(n: number, d = 0): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

export function short(a?: string | null, l = 4, r = 4): string {
  if (!a) return '';
  return a.length <= l + r ? a : `${a.slice(0, l)}…${a.slice(-r)}`;
}

export function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'; // guards Infinity too, not just NaN
  return Number(n).toLocaleString('en-US');
}

export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'; // "InfinityM" is not a number
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}${round(a / 1e6, 2)}M`;
  if (a >= 1e3) return `${sign}${round(a / 1e3, 1)}k`;
  return `${sign}${round(a, 0)}`;
}

export function sol(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1000) return `${sign}${round(a / 1000, 2)}k`;
  if (a >= 1) return `${sign}${round(a, 2)}`;
  return `${sign}${round(a, 3)}`;
}

export function solSigned(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${sol(Math.abs(n))}`;
}

export function pct(n: number | null | undefined, d = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${round(n, d).toFixed(d)}%`;
}

export function ago(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function date(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function time(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// Thresholds match the production tier system (lib/indexer/wallet-tags.ts:
// TIER_S_MIN=70, TIER_A_MIN=50, TIER_B_MIN=30) so grades are consistent with
// the leaderboard everywhere they're shown.
export function tierFromScore(s?: number | null): 'S' | 'A' | 'B' | 'C' | null {
  if (s == null || !Number.isFinite(s)) return null;
  return s >= 70 ? 'S' : s >= 50 ? 'A' : s >= 30 ? 'B' : 'C';
}

export const fmt = { short, num, compact, sol, solSigned, pct, ago, date, time, tierFromScore };
