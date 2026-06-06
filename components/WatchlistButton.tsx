'use client';

import { Star } from 'lucide-react';
import { useWatchlist } from '@/lib/useWatchlist';

interface WatchlistButtonProps {
  address: string;
  className?: string;
}

/**
 * Small star toggle that adds/removes a wallet from the local watchlist.
 * Stops click propagation so it never triggers the surrounding row's
 * navigation handler.
 */
export default function WatchlistButton({ address, className = '' }: WatchlistButtonProps) {
  const { isWatched, toggle } = useWatchlist();
  const watched = isWatched(address);

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggle(address);
      }}
      className={`p-1 rounded transition-colors hover:bg-gray-700 ${
        watched ? 'text-amber-400' : 'text-gray-500 hover:text-amber-300'
      } ${className}`}
      title={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      aria-label={watched ? 'Remove from watchlist' : 'Add to watchlist'}
      aria-pressed={watched}
    >
      <Star className="w-4 h-4" fill={watched ? 'currentColor' : 'none'} />
    </button>
  );
}
