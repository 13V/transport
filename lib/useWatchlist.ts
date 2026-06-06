'use client';

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'smartMoneyWatchlist';
const OWNER_KEY = 'sm_owner_id';

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
 * Stable per-device owner identity.
 *
 * Today this is a random UUID minted on first use and kept in localStorage. It
 * is the key under which the server-side watchlist is stored (see
 * app/api/watchlist + supabase/migrations/0003_watchlist.sql).
 *
 * FUTURE: when wallet-connect / token-gating lands, this can be replaced by the
 * connected wallet address so a user's watchlist follows their wallet across
 * devices. Nothing here depends on wallet-connect now — keep it self-contained.
 */
function getOwnerId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    let id = window.localStorage.getItem(OWNER_KEY);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : // Fallback for older browsers without crypto.randomUUID.
            `sm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(OWNER_KEY, id);
    }
    return id;
  } catch {
    // Private mode / disabled storage → no stable identity; server sync is
    // skipped and we operate localStorage-only (in-memory only here).
    return null;
  }
}

/**
 * Watchlist of smart-money wallet addresses, backed by a server-side store
 * (Supabase) with localStorage as an instant, offline fallback.
 *
 * Behaviour:
 *  - SSR-safe: starts empty on the server, hydrates from localStorage on mount
 *    (instant), then fetches the owner's server set and merges it in.
 *  - `toggle` updates local state + localStorage immediately (optimistic) AND
 *    fires the matching server POST/DELETE. Server failures are swallowed so the
 *    UI never crashes — the change still lives in localStorage.
 *  - When Supabase isn't configured the server calls are graceful no-ops, so the
 *    hook behaves exactly as the old localStorage-only version.
 *
 * The public API ({ watchlist, isWatched, toggle }) is unchanged.
 */
export function useWatchlist(): {
  watchlist: string[];
  isWatched: (addr: string) => boolean;
  toggle: (addr: string) => void;
} {
  const [watchlist, setWatchlist] = useState<string[]>([]);

  // Hydrate from localStorage after mount (avoids SSR hydration mismatch), then
  // merge in the server set for this owner.
  useEffect(() => {
    const local = readStored();
    setWatchlist(local);

    // Keep instances in this tab and across tabs in sync.
    const onChange = () => setWatchlist(readStored());
    window.addEventListener('storage', onChange);
    window.addEventListener('smartMoneyWatchlist:change', onChange);

    let active = true;
    const owner = getOwnerId();
    if (owner) {
      (async () => {
        try {
          const res = await fetch(`/api/watchlist?owner=${encodeURIComponent(owner)}`);
          if (!res.ok) return;
          const json = (await res.json()) as { addresses?: unknown };
          const server = Array.isArray(json.addresses)
            ? json.addresses.filter((x): x is string => typeof x === 'string')
            : [];
          if (!active || server.length === 0) return;
          // Merge server + local (union), persist back so localStorage is the
          // authoritative offline cache, and push any local-only entries that
          // the server hasn't seen yet (e.g. starred before this device synced).
          const current = readStored();
          const merged = Array.from(new Set([...current, ...server]));
          if (merged.length !== current.length) {
            try {
              window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
              window.dispatchEvent(new Event('smartMoneyWatchlist:change'));
            } catch {
              /* ignore quota / private-mode write failures */
            }
          }
          setWatchlist(merged);

          const localOnly = current.filter((a) => !server.includes(a));
          for (const address of localOnly) {
            void serverWrite('POST', owner, address);
          }
        } catch {
          // Network / server unavailable → stay on the localStorage set.
        }
      })();
    }

    return () => {
      active = false;
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
      const adding = !current.includes(addr);
      const next = adding ? [...current, addr] : current.filter((a) => a !== addr);
      // Optimistic local update.
      persist(next);
      // Fire-and-forget server sync; failures don't affect the local state.
      const owner = getOwnerId();
      if (owner) {
        void serverWrite(adding ? 'POST' : 'DELETE', owner, addr);
      }
    },
    [persist]
  );

  return { watchlist, isWatched, toggle };
}

/**
 * Best-effort write to the server store. Never throws — when Supabase isn't
 * configured the route returns a 200 no-op, and any network error is ignored so
 * the optimistic localStorage update stands.
 */
async function serverWrite(
  method: 'POST' | 'DELETE',
  owner: string,
  address: string
): Promise<void> {
  try {
    await fetch('/api/watchlist', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, address }),
    });
  } catch {
    // Swallow — local state is the source of truth offline.
  }
}
