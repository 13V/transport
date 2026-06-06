'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Star, Copy } from 'lucide-react';
import { useWatchlist } from '@/lib/useWatchlist';
import * as f from '@/lib/format';
import {
  TierBadge, Roi, Pnl, WinBar, EmptyState, ErrorState, SkTable,
  AddrChip, WatchStar, CopyIconButton,
} from '@/components/ui';

interface ListWallet {
  address: string;
  score: number;
  pnl: number | null;
  roiPct: number | null;
  verified?: boolean;
  winRate?: number;
  tier?: string;
}

interface ListResponse {
  count: number;
  wallets: ListWallet[];
}

export default function WatchlistView() {
  const router = useRouter();
  const { watchlist } = useWatchlist();
  const [wallets, setWallets] = useState<ListWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch the curated list once; we filter it down to watched addresses below.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/smart-money/list?limit=1000&verified=0&gate=0');
        if (!res.ok) throw new Error('Failed to load wallet list');
        const json = (await res.json()) as ListResponse;
        if (active) setWallets(json.wallets ?? []);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load wallet list');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Watched wallets enriched with stats from the list. Wallets in the watchlist
  // that aren't in the curated list still show up (address only).
  const rows = useMemo(() => {
    const byAddress = new Map(wallets.map((w) => [w.address, w]));
    return watchlist.map(
      (address) => byAddress.get(address) ?? ({ address, score: 0, pnl: null, roiPct: null } as ListWallet)
    );
  }, [watchlist, wallets]);

  const copyAddresses = () => {
    navigator.clipboard?.writeText(watchlist.join('\n')).catch(() => {});
  };

  const pageHead = (
    <div className="page-head">
      <div className="sub">
        {watchlist.length} wallet{watchlist.length !== 1 ? 's' : ''} tracked
      </div>
      {watchlist.length > 0 && (
        <div className="page-head-actions">
          <button type="button" className="btn pos-soft sm" onClick={copyAddresses}>
            <Copy size={15} /> Copy addresses
          </button>
        </div>
      )}
    </div>
  );

  if (loading) {
    return (
      <div className="view stack gap-24">
        {pageHead}
        <SkTable cols={5} rows={6} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="view stack gap-24">
        {pageHead}
        <div className="card">
          <ErrorState msg="Couldn’t load watchlist stats." />
        </div>
      </div>
    );
  }

  if (watchlist.length === 0) {
    return (
      <div className="view stack gap-24">
        {pageHead}
        <div className="card">
          <EmptyState
            icon={Star}
            title="Your watchlist is empty"
            msg="Star wallets on the leaderboard to keep an eye on their ROI, PnL, and new buys here."
            action="Browse Smart Money"
            actionHref="/smart-money"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="view stack gap-24">
      {pageHead}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>Wallet</th>
                <th className="c">Tier</th>
                <th className="r">ROI</th>
                <th className="r">PnL</th>
                <th className="r">Win rate</th>
                <th className="r" style={{ width: 84 }}>Watch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr
                  key={w.address}
                  className="clickable"
                  onClick={() => router.push(`/smart-money/${w.address}`)}
                >
                  <td><AddrChip address={w.address} copy={false} /></td>
                  <td className="c">
                    <TierBadge tier={w.tier ?? (w.score > 0 ? f.tierFromScore(w.score) : null)} />
                  </td>
                  <td className="r"><Roi value={w.roiPct} /></td>
                  <td className="r"><Pnl value={w.pnl} /></td>
                  <td className="r"><WinBar value={w.winRate} /></td>
                  <td className="r">
                    <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                      <CopyIconButton text={w.address} title="Copy address" />
                      <WatchStar address={w.address} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
