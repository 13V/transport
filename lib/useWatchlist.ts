'use client';

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'smartMoneyWatchlist';

function readStored(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * localStorage-backed watchlist of smart-money wallet addresses.
 *
 * SSR-safe: starts empty on the server and hydrates from localStorage in an
 * effect. Changes are persisted back to localStorage and broadcast to other
 * hook instances (and other tabs) so multiple consumers stay in sync.
 */
export function useWatchlist(): {
  watchlist: string[];
  isWatched: (addr: string) => boolean;
  toggle: (addr: string) => void;
} {
  const [watchlist, setWatchlist] = useState<string[]>([]);

  // Hydrate from localStorage after mount (avoids SSR hydration mismatch).
  useEffect(() => {
    setWatchlist(readStored());

    // Keep instances in this tab and across tabs in sync.
    const onChange = () => setWatchlist(readStored());
    window.addEventListener('storage', onChange);
    window.addEventListener('smartMoneyWatchlist:change', onChange);
    return () => {
      window.removeEventListener('storage', onChange);
      window.removeEventListener('smartMoneyWatchlist:change', onChange);
    };
  }, []);

  const persist = useCallback((next: string[]) => {
    setWatchlist(next);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      // Notify other hook instances in this tab.
      window.dispatchEvent(new Event('smartMoneyWatchlist:change'));
    } catch {
      // Ignore quota / private-mode write failures.
    }
  }, []);

  const isWatched = useCallback(
    (addr: string) => watchlist.includes(addr),
    [watchlist]
  );

  const toggle = useCallback(
    (addr: string) => {
      const current = readStored();
      const next = current.includes(addr)
        ? current.filter((a) => a !== addr)
        : [...current, addr];
      persist(next);
    },
    [persist]
  );

  return { watchlist, isWatched, toggle };
}
