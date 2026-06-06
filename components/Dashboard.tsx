'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader } from 'lucide-react';

// ---- API response shapes -------------------------------------------------

interface StatusResponse {
  totals: {
    walletsIndexed: number;
    verifiedWallets: number;
    smartWallets: number;
  };
  migrationApplied?: boolean;
}

interface ListWallet {
  address: string;
  roiPct: number | null;
  pnl: number;
  winRate: number;
  verified: boolean;
  tier?: string;
}

interface ListResponse {
  wallets: ListWallet[];
}

interface BuyingToken {
  mint: string;
  distinctSmartBuyers: number;
  solVolume: number;
}

interface BuyingResponse {
  tokens: BuyingToken[];
}

// ---- Formatting helpers --------------------------------------------------

function shortAddr(addr: string): string {
  if (!addr) return '';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function formatSol(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(3)}`;
}

function tierColor(tier?: string): string {
  switch (tier) {
    case 'S':
      return 'bg-amber-500/15 text-amber-400 ring-amber-500/30';
    case 'A':
      return 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30';
    case 'B':
      return 'bg-blue-500/15 text-blue-400 ring-blue-500/30';
    default:
      return 'bg-gray-500/15 text-gray-400 ring-gray-500/30';
  }
}

// ---- Small building blocks -----------------------------------------------

function StatCard({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: number | null;
  hint: string;
  loading: boolean;
}) {
  return (
    <div className="card space-y-1">
      <p className="text-sm text-gray-400">{label}</p>
      {loading ? (
        <div className="h-8 w-24 animate-pulse rounded bg-gray-800" />
      ) : (
        <p className="text-3xl font-bold text-gray-100">{formatNumber(value)}</p>
      )}
      <p className="text-xs text-gray-500">{hint}</p>
    </div>
  );
}

function PanelLoading() {
  return (
    <div className="py-10 text-center">
      <Loader className="mx-auto mb-3 h-6 w-6 animate-spin text-blue-400" />
      <p className="text-sm text-gray-400">Loading…</p>
    </div>
  );
}

function PanelEmpty({ message }: { message: string }) {
  return (
    <div className="py-10 text-center text-sm text-gray-500">{message}</div>
  );
}

// ---- Main component ------------------------------------------------------

export default function Dashboard() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const [topWallets, setTopWallets] = useState<ListWallet[] | null>(null);
  const [topLoading, setTopLoading] = useState(true);

  const [buying, setBuying] = useState<BuyingToken[] | null>(null);
  const [buyingLoading, setBuyingLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error('status');
        const json = (await res.json()) as StatusResponse;
        if (!cancelled) setStatus(json);
      } catch {
        if (!cancelled) setStatus(null);
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    }

    async function loadTop() {
      try {
        const res = await fetch('/api/smart-money/list?sort=roi&limit=10');
        if (!res.ok) throw new Error('list');
        const json = (await res.json()) as ListResponse;
        if (!cancelled) setTopWallets(json.wallets ?? []);
      } catch {
        if (!cancelled) setTopWallets([]);
      } finally {
        if (!cancelled) setTopLoading(false);
      }
    }

    async function loadBuying() {
      try {
        const res = await fetch('/api/smart-money/buying?hours=24&limit=10');
        if (!res.ok) throw new Error('buying');
        const json = (await res.json()) as BuyingResponse;
        if (!cancelled) setBuying(json.tokens ?? []);
      } catch {
        if (!cancelled) setBuying([]);
      } finally {
        if (!cancelled) setBuyingLoading(false);
      }
    }

    loadStatus();
    loadTop();
    loadBuying();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-10">
      {/* Hero */}
      <div className="space-y-3 text-center">
        <h2 className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-4xl font-bold text-transparent">
          Solana Smart Money
        </h2>
        <p className="mx-auto max-w-2xl text-lg text-gray-400">
          Accurate, all-time-ROI-verified wallets to track and follow.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <StatCard
          label="Wallets indexed"
          value={status?.totals.walletsIndexed ?? null}
          hint="Total wallets in the index"
          loading={statusLoading}
        />
        <StatCard
          label="Verified"
          value={status?.totals.verifiedWallets ?? null}
          hint="Accurate all-time ROI"
          loading={statusLoading}
        />
        <StatCard
          label="Smart"
          value={status?.totals.smartWallets ?? null}
          hint="Curated smart money"
          loading={statusLoading}
        />
      </div>

      {/* Side-by-side panels */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Top smart money by ROI */}
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-100">
              🏆 Top smart money by ROI
            </h3>
            <Link
              href="/smart-money"
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              View full leaderboard →
            </Link>
          </div>

          {topLoading ? (
            <PanelLoading />
          ) : !topWallets || topWallets.length === 0 ? (
            <PanelEmpty message="No verified wallets yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs text-gray-400">
                    <th className="px-2 py-2 font-semibold">Wallet</th>
                    <th className="px-2 py-2 font-semibold">Tier</th>
                    <th className="px-2 py-2 text-right font-semibold">ROI</th>
                    <th className="px-2 py-2 text-right font-semibold">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {topWallets.map((w) => (
                    <tr
                      key={w.address}
                      className="border-b border-gray-800/60 last:border-0 hover:bg-gray-800/40 transition-colors"
                    >
                      <td className="px-2 py-2">
                        <Link
                          href={`/smart-money/${w.address}`}
                          className="font-mono text-xs text-gray-200 hover:text-blue-400 transition-colors"
                        >
                          {shortAddr(w.address)}
                        </Link>
                      </td>
                      <td className="px-2 py-2">
                        {w.tier ? (
                          <span
                            className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${tierColor(
                              w.tier
                            )}`}
                          >
                            {w.tier}
                          </span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        {w.roiPct == null ? (
                          <span className="text-gray-600">—</span>
                        ) : (
                          <span
                            className={`font-bold ${
                              w.roiPct >= 0 ? 'text-green-400' : 'text-red-400'
                            }`}
                          >
                            {w.roiPct >= 0 ? '+' : ''}
                            {w.roiPct.toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <span
                          className={
                            w.pnl >= 0 ? 'text-gray-300' : 'text-red-400'
                          }
                        >
                          {w.pnl >= 0 ? '+' : '-'}
                          {formatSol(w.pnl)} SOL
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Smart money buying now */}
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-100">
              📈 Smart money buying now
            </h3>
            <Link
              href="/smart-money/buying"
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              See all →
            </Link>
          </div>

          {buyingLoading ? (
            <PanelLoading />
          ) : !buying || buying.length === 0 ? (
            <PanelEmpty message="No smart money buys in the last 24h." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-left text-xs text-gray-400">
                    <th className="px-2 py-2 font-semibold">Token</th>
                    <th className="px-2 py-2 text-right font-semibold">Buyers</th>
                    <th className="px-2 py-2 text-right font-semibold">SOL vol</th>
                  </tr>
                </thead>
                <tbody>
                  {buying.map((t) => (
                    <tr
                      key={t.mint}
                      className="border-b border-gray-800/60 last:border-0 hover:bg-gray-800/40 transition-colors"
                    >
                      <td className="px-2 py-2">
                        <Link
                          href={`/token/${t.mint}`}
                          className="font-mono text-xs text-gray-200 hover:text-blue-400 transition-colors"
                        >
                          {shortAddr(t.mint)}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-right font-semibold text-emerald-400">
                        {formatNumber(t.distinctSmartBuyers)}
                      </td>
                      <td className="px-2 py-2 text-right text-gray-300">
                        {formatSol(t.solVolume)} SOL
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
