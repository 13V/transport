'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Loader, ExternalLink, CheckCircle2 } from 'lucide-react';
import CopyButton from './CopyButton';
import WalletHistoryChart from './WalletHistoryChart';

/**
 * WALLET PROFILE (rich header view)
 *
 * Renders a single wallet's at-a-glance performance profile by stitching
 * together the /profile and /holdings APIs. Designed to sit above the existing
 * <WalletDetail> on the wallet page, so every section degrades gracefully when
 * a piece of data is missing or empty.
 */

interface ProfileStats {
  score: number | null;
  roiPct: number | null;
  realizedPnl: number | null;
  investedSol: number | null;
  winRate: number | null;
  consistency: number | null;
  totalTrades: number | null;
  tokensTraded: number | null;
  verified: boolean | null;
  seeded: boolean | null;
  fundedBy: string | null;
  lastTradeAt: string | null;
}

interface TokenPnl {
  mint: string;
  realizedPnlSol: number;
  roiPct: number;
  trades: number;
}

interface RecentTrade {
  mint: string;
  type: 'BUY' | 'SELL' | string;
  amountSol: number;
  source: string;
  txHash: string;
  at: string;
}

interface ClusterLink {
  wallet: string;
  amountSol: number;
  transfers: number;
  lastSeen: string;
}

interface ProfileResponse {
  address: string;
  stats: ProfileStats | null;
  perToken: { best: TokenPnl[]; worst: TokenPnl[] };
  recentTrades: RecentTrade[];
  cluster: { funded: ClusterLink[]; fundedBy: ClusterLink[] };
}

interface Holding {
  mint: string;
  tokens: number;
  currentValueSol: number;
  avgCostSol: number;
  unrealizedSol: number;
  priceSol: number;
}

interface HoldingsResponse {
  address: string;
  holdings: Holding[];
  totals: { unrealizedSol: number; currentValueSol: number };
}

interface WalletProfileProps {
  walletAddress: string;
}

// --- helpers ---------------------------------------------------------------

const shortAddr = (addr: string): string =>
  addr && addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr || '';

const fmtSol = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(3);
};

const fmtPct = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
};

const fmtSolSigned = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(3)}`;
};

const pnlColor = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return 'text-gray-400';
  return n >= 0 ? 'text-green-400' : 'text-red-400';
};

const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
};

// Rough tier derived from score, mirroring the leaderboard's banding.
const tierFromScore = (score: number | null): { tier: string; classes: string } => {
  const s = score ?? 0;
  if (s >= 70) return { tier: 'S', classes: 'bg-amber-500/15 text-amber-400 ring-amber-500/30' };
  if (s >= 50) return { tier: 'A', classes: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30' };
  if (s >= 30) return { tier: 'B', classes: 'bg-blue-500/15 text-blue-400 ring-blue-500/30' };
  return { tier: 'C', classes: 'bg-gray-500/15 text-gray-400 ring-gray-500/30' };
};

// --- component -------------------------------------------------------------

export default function WalletProfile({ walletAddress }: WalletProfileProps) {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [holdings, setHoldings] = useState<HoldingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [profileRes, holdingsRes] = await Promise.all([
          fetch(`/api/wallet/${walletAddress}/profile`),
          fetch(`/api/wallet/${walletAddress}/holdings`),
        ]);

        if (!profileRes.ok) throw new Error(`Failed to load profile (${profileRes.status})`);
        if (!holdingsRes.ok) throw new Error(`Failed to load holdings (${holdingsRes.status})`);

        const profileJson = (await profileRes.json()) as ProfileResponse;
        const holdingsJson = (await holdingsRes.json()) as HoldingsResponse;

        if (!cancelled) {
          setProfile(profileJson);
          setHoldings(holdingsJson);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load wallet profile');
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
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-8">
        <div className="text-center">
          <Loader className="w-7 h-7 mx-auto animate-spin text-blue-400 mb-3" />
          <p className="text-gray-400 text-sm">Loading wallet profile…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200 text-sm">
        {error}
      </div>
    );
  }

  if (!profile) return null;

  const stats = profile.stats;
  const { best = [], worst = [] } = profile.perToken ?? {};
  const recentTrades = profile.recentTrades ?? [];
  const cluster = profile.cluster ?? { funded: [], fundedBy: [] };
  const fundedBy = cluster.fundedBy ?? [];
  const funded = cluster.funded ?? [];
  const holdingList = holdings?.holdings ?? [];
  const unrealizedTotal = holdings?.totals?.unrealizedSol ?? null;

  const { tier, classes: tierClasses } = tierFromScore(stats?.score ?? null);
  const recent = recentTrades.slice(0, 15);

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-6 space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <code className="text-sm bg-gray-800 px-3 py-1.5 rounded-lg text-gray-200 font-mono">
            {shortAddr(profile.address)}
          </code>
          <CopyButton text={profile.address} label="wallet address" />
          {stats?.verified && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-400 ring-1 ring-emerald-500/30">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Verified
            </span>
          )}
          {stats?.seeded && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-400 ring-1 ring-amber-500/30">
              ⭐ Seeded
            </span>
          )}
          <span
            className={`inline-flex items-center justify-center rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${tierClasses}`}
            title={`Tier ${tier} (derived from score)`}
          >
            Tier {tier}
          </span>
          <a
            href={`https://solscan.io/address/${profile.address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            Solscan
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        {/* Big headline stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-lg bg-gray-800/50 p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">ROI (all-time)</p>
            <p className={`text-2xl font-bold ${pnlColor(stats?.roiPct)}`}>
              {fmtPct(stats?.roiPct)}
            </p>
          </div>
          <div className="rounded-lg bg-gray-800/50 p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Realized PnL</p>
            <p className={`text-2xl font-bold ${pnlColor(stats?.realizedPnl)}`}>
              {fmtSolSigned(stats?.realizedPnl)}
              <span className="text-sm font-normal text-gray-400 ml-1">SOL</span>
            </p>
          </div>
          <div className="rounded-lg bg-gray-800/50 p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Unrealized PnL</p>
            <p className={`text-2xl font-bold ${pnlColor(unrealizedTotal)}`}>
              {fmtSolSigned(unrealizedTotal)}
              <span className="text-sm font-normal text-gray-400 ml-1">SOL</span>
            </p>
          </div>
          <div className="rounded-lg bg-gray-800/50 p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">Score</p>
            <p className="text-2xl font-bold text-gray-100">
              {stats?.score != null ? stats.score.toFixed(1) : '—'}
            </p>
          </div>
        </div>

        {/* Stat grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
          <Stat label="Win Rate" value={stats?.winRate != null ? `${(stats.winRate * 100).toFixed(1)}%` : '—'} />
          <Stat label="Consistency" value={stats?.consistency != null ? `${stats.consistency.toFixed(0)}/100` : '—'} />
          <Stat label="Total Trades" value={stats?.totalTrades != null ? String(stats.totalTrades) : '—'} />
          <Stat label="Tokens Traded" value={stats?.tokensTraded != null ? String(stats.tokensTraded) : '—'} />
          <Stat label="Invested" value={stats?.investedSol != null ? `${fmtSol(stats.investedSol)} SOL` : '—'} />
          <Stat label="Last Trade" value={stats?.lastTradeAt ? new Date(stats.lastTradeAt).toLocaleDateString() : '—'} />
        </div>
      </div>

      {/* ROI history */}
      <WalletHistoryChart walletAddress={walletAddress} />

      {/* Current holdings */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-6">
        <h3 className="text-lg font-semibold mb-4">Current holdings</h3>
        {holdingList.length === 0 ? (
          <p className="text-sm text-gray-500">No open positions.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-gray-400">
                  <th className="px-3 py-2 font-semibold">Token</th>
                  <th className="px-3 py-2 font-semibold text-right">Tokens</th>
                  <th className="px-3 py-2 font-semibold text-right">Value (SOL)</th>
                  <th className="px-3 py-2 font-semibold text-right">Unrealized</th>
                  <th className="px-3 py-2 font-semibold text-right">Avg Cost</th>
                </tr>
              </thead>
              <tbody>
                {holdingList.map((h) => (
                  <tr key={h.mint} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-3 py-2">
                      <code className="text-xs font-mono text-gray-300">{shortAddr(h.mint)}</code>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-300">{h.tokens.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-gray-200">{fmtSol(h.currentValueSol)}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${pnlColor(h.unrealizedSol)}`}>
                      {fmtSolSigned(h.unrealizedSol)}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-400">{fmtSol(h.avgCostSol)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Best / worst tokens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TokenTable title="Best tokens" tone="best" rows={best} />
        <TokenTable title="Worst tokens" tone="worst" rows={worst} />
      </div>

      {/* Recent trades */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-6">
        <h3 className="text-lg font-semibold mb-4">Recent trades</h3>
        {recent.length === 0 ? (
          <p className="text-sm text-gray-500">No recent trades.</p>
        ) : (
          <ul className="space-y-2">
            {recent.map((t, i) => {
              const isSell = String(t.type).toUpperCase() === 'SELL';
              return (
                <li
                  key={`${t.txHash}-${i}`}
                  className="flex flex-wrap items-center gap-3 rounded-lg bg-gray-800/40 px-3 py-2 text-sm"
                >
                  <span
                    className={`inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold ${
                      isSell
                        ? 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30'
                        : 'bg-green-500/15 text-green-400 ring-1 ring-green-500/30'
                    }`}
                  >
                    {isSell ? 'SELL' : 'BUY'}
                  </span>
                  <code className="text-xs font-mono text-gray-300">{shortAddr(t.mint)}</code>
                  <span className="text-gray-200">{fmtSol(t.amountSol)} SOL</span>
                  {t.source && (
                    <span className="text-xs text-gray-500">{t.source}</span>
                  )}
                  <span className="text-xs text-gray-500 ml-auto">{fmtTime(t.at)}</span>
                  {t.txHash && (
                    <a
                      href={`https://solscan.io/tx/${t.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center text-blue-400 hover:text-blue-300 transition-colors"
                      title="View transaction on Solscan"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Wallet cluster */}
      {(fundedBy.length > 0 || funded.length > 0) && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-6 space-y-4">
          <div>
            <h3 className="text-lg font-semibold">Wallet cluster</h3>
            <p className="text-xs text-gray-500 mt-1">
              SOL funding links — these wallets are likely controlled by the same trader.
            </p>
          </div>

          {fundedBy.length > 0 && (
            <ClusterList title="Funded by" links={fundedBy} />
          )}
          {funded.length > 0 && (
            <ClusterList title="Funded these wallets" links={funded} />
          )}
        </div>
      )}
    </div>
  );
}

// --- subcomponents ---------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-800/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="font-semibold text-gray-200">{value}</p>
    </div>
  );
}

function TokenTable({
  title,
  tone,
  rows,
}: {
  title: string;
  tone: 'best' | 'worst';
  rows: TokenPnl[];
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-6">
      <h3 className="text-lg font-semibold mb-4">{title}</h3>
      {(!rows || rows.length === 0) ? (
        <p className="text-sm text-gray-500">No data.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-gray-400">
                <th className="px-3 py-2 font-semibold">Token</th>
                <th className="px-3 py-2 font-semibold text-right">PnL (SOL)</th>
                <th className="px-3 py-2 font-semibold text-right">ROI</th>
                <th className="px-3 py-2 font-semibold text-right">Trades</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.mint} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-3 py-2">
                    <code className="text-xs font-mono text-gray-300">{shortAddr(r.mint)}</code>
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${pnlColor(r.realizedPnlSol)}`}>
                    {fmtSolSigned(r.realizedPnlSol)}
                  </td>
                  <td className={`px-3 py-2 text-right ${pnlColor(r.roiPct)}`}>{fmtPct(r.roiPct)}</td>
                  <td className="px-3 py-2 text-right text-gray-400">{r.trades}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClusterList({ title, links }: { title: string; links: ClusterLink[] }) {
  return (
    <div>
      <p className="text-sm font-semibold text-gray-300 mb-2">{title}</p>
      <ul className="space-y-2">
        {links.map((l) => (
          <li
            key={l.wallet}
            className="flex flex-wrap items-center gap-3 rounded-lg bg-gray-800/40 px-3 py-2 text-sm"
          >
            <Link
              href={`/smart-money/${l.wallet}`}
              className="inline-flex items-center gap-1 rounded bg-purple-500/15 px-2 py-0.5 text-xs font-mono font-semibold text-purple-300 ring-1 ring-purple-500/30 hover:bg-purple-500/25 transition-colors"
            >
              🔗 {shortAddr(l.wallet)}
            </Link>
            <span className="text-gray-200">{fmtSol(l.amountSol)} SOL</span>
            <span className="text-xs text-gray-500">
              {l.transfers} transfer{l.transfers === 1 ? '' : 's'}
            </span>
            {l.lastSeen && (
              <span className="text-xs text-gray-500 ml-auto">{fmtTime(l.lastSeen)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
