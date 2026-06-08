'use client';

/* =========================================================================
   COPY CONFIG — the user's client-side "copy list".

   Per-source-wallet copy settings (default SOL size, max per trade, enabled
   flag) persisted in localStorage. NOTHING here moves funds or signs anything:
   it is purely the user's saved preferences for the NON-CUSTODIAL copy flow
   (CopyTradeButton deep-links the user's own wallet using these defaults).

   The custodial auto-exec engine (lib/copy-engine.ts) is scaffolded but
   DISABLED; if it is ever enabled it would READ this same config as the source
   of per-wallet spend limits — which is why `maxPerTradeSol` exists today.

   Storage shape (localStorage key `copy.config.v1`):
     {
       version: 1,
       globalDefaultSol: number,            // fallback size when a wallet has none
       wallets: {
         [sourceWallet: string]: {
           enabled: boolean,                // in the user's copy list?
           defaultSol: number | null,       // preferred clip size for this wallet
           maxPerTradeSol: number | null,   // hard cap per copy (safety)
           note?: string | null,            // optional user label
           updatedAt: number,
         }
       }
     }
   ========================================================================= */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'copy.config.v1';
const CONFIG_VERSION = 1 as const;

/** Sensible default clip when the user hasn't set a per-wallet or global size. */
export const DEFAULT_GLOBAL_SOL = 0.5;
/** Quick-amount presets shared by the UI (SOL). */
export const SOL_PRESETS = [0.1, 0.5, 1, 5] as const;

export interface WalletCopySettings {
  /** Whether this source wallet is in the user's active copy list. */
  enabled: boolean;
  /** Preferred clip size (SOL) when copying this wallet. null → use global. */
  defaultSol: number | null;
  /** Hard per-trade cap (SOL). null → no cap. A safety ceiling, also consumed
   *  by the (disabled) custodial engine as the per-user spend limit. */
  maxPerTradeSol: number | null;
  /** Optional human label for this wallet. */
  note?: string | null;
  /** Epoch ms of last change (last-write-wins; useful for future sync). */
  updatedAt: number;
}

export interface CopyConfig {
  version: typeof CONFIG_VERSION;
  /** Fallback clip size used when a wallet has no `defaultSol`. */
  globalDefaultSol: number;
  /** Per-source-wallet settings, keyed by base58 address. */
  wallets: Record<string, WalletCopySettings>;
}

/** A fresh, empty config. Pure — safe on the server. */
export function emptyConfig(): CopyConfig {
  return { version: CONFIG_VERSION, globalDefaultSol: DEFAULT_GLOBAL_SOL, wallets: {} };
}

/** Coerce an arbitrary value to a positive finite number, else null. */
function posOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Normalize a parsed blob into a valid CopyConfig (defensive against drift). */
function normalize(raw: unknown): CopyConfig {
  const out = emptyConfig();
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;

  const g = posOrNull(obj.globalDefaultSol);
  if (g != null) out.globalDefaultSol = g;

  const wallets = obj.wallets;
  if (wallets && typeof wallets === 'object') {
    for (const [addr, val] of Object.entries(wallets as Record<string, unknown>)) {
      if (!addr || !val || typeof val !== 'object') continue;
      const w = val as Record<string, unknown>;
      out.wallets[addr] = {
        enabled: Boolean(w.enabled),
        defaultSol: posOrNull(w.defaultSol),
        maxPerTradeSol: posOrNull(w.maxPerTradeSol),
        note: typeof w.note === 'string' ? w.note : null,
        updatedAt: Number.isFinite(Number(w.updatedAt)) ? Number(w.updatedAt) : Date.now(),
      };
    }
  }
  return out;
}

/** Read the config from localStorage (returns an empty config off-client). */
export function readCopyConfig(): CopyConfig {
  if (typeof window === 'undefined') return emptyConfig();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyConfig();
    return normalize(JSON.parse(raw));
  } catch {
    return emptyConfig();
  }
}

/** Persist the config to localStorage. No-op / swallow on failure. */
export function writeCopyConfig(cfg: CopyConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* quota / private-mode — non-fatal */
  }
}

/**
 * Resolve the effective clip size (SOL) for a source wallet:
 * per-wallet defaultSol → global default, then clamped to the wallet's
 * maxPerTradeSol cap when one is set. Pure helper, reused by the UI and the
 * (disabled) engine so the size math is identical everywhere.
 */
export function resolveCopySize(cfg: CopyConfig, sourceWallet?: string | null): number {
  const w = sourceWallet ? cfg.wallets[sourceWallet] : undefined;
  let size = w?.defaultSol ?? cfg.globalDefaultSol ?? DEFAULT_GLOBAL_SOL;
  const cap = w?.maxPerTradeSol;
  if (cap != null && size > cap) size = cap;
  return size;
}

export interface UseCopyConfig {
  config: CopyConfig;
  /** True after the first client hydration (avoids SSR mismatch flashes). */
  ready: boolean;
  /** Settings for one wallet (or undefined if not in the list). */
  getWallet: (wallet: string) => WalletCopySettings | undefined;
  /** Is this wallet in the active copy list? */
  isEnabled: (wallet: string) => boolean;
  /** Merge-update one wallet's settings (creates the entry if absent). */
  setWallet: (wallet: string, patch: Partial<WalletCopySettings>) => void;
  /** Add/enable a wallet in the copy list. */
  enableWallet: (wallet: string) => void;
  /** Disable (keep settings) a wallet. */
  disableWallet: (wallet: string) => void;
  /** Remove a wallet entirely from the list. */
  removeWallet: (wallet: string) => void;
  /** Set the global fallback clip size. */
  setGlobalDefaultSol: (sol: number) => void;
  /** Effective clip size for a wallet (see resolveCopySize). */
  sizeFor: (wallet?: string | null) => number;
}

/**
 * useCopyConfig — client hook over the persisted copy list. Hydrates from
 * localStorage on mount, mirrors writes back, and stays in sync across tabs via
 * the `storage` event. Server render returns an empty config with ready=false.
 */
export function useCopyConfig(): UseCopyConfig {
  const [config, setConfig] = useState<CopyConfig>(emptyConfig);
  const [ready, setReady] = useState(false);

  // Hydrate once on mount.
  useEffect(() => {
    setConfig(readCopyConfig());
    setReady(true);
  }, []);

  // Cross-tab sync.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setConfig(readCopyConfig());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Apply an updater, persist, and update state in one shot.
  const mutate = useCallback((fn: (prev: CopyConfig) => CopyConfig) => {
    setConfig((prev) => {
      const next = fn(prev);
      writeCopyConfig(next);
      return next;
    });
  }, []);

  const setWallet = useCallback((wallet: string, patch: Partial<WalletCopySettings>) => {
    if (!wallet) return;
    mutate((prev) => {
      const existing = prev.wallets[wallet];
      const base: WalletCopySettings = existing ?? {
        enabled: false,
        defaultSol: null,
        maxPerTradeSol: null,
        note: null,
        updatedAt: Date.now(),
      };
      return {
        ...prev,
        wallets: {
          ...prev.wallets,
          [wallet]: { ...base, ...patch, updatedAt: Date.now() },
        },
      };
    });
  }, [mutate]);

  const enableWallet = useCallback((wallet: string) => setWallet(wallet, { enabled: true }), [setWallet]);
  const disableWallet = useCallback((wallet: string) => setWallet(wallet, { enabled: false }), [setWallet]);

  const removeWallet = useCallback((wallet: string) => {
    if (!wallet) return;
    mutate((prev) => {
      if (!prev.wallets[wallet]) return prev;
      const wallets = { ...prev.wallets };
      delete wallets[wallet];
      return { ...prev, wallets };
    });
  }, [mutate]);

  const setGlobalDefaultSol = useCallback((sol: number) => {
    const s = posOrNull(sol);
    if (s == null) return;
    mutate((prev) => ({ ...prev, globalDefaultSol: s }));
  }, [mutate]);

  const getWallet = useCallback((wallet: string) => config.wallets[wallet], [config]);
  const isEnabled = useCallback((wallet: string) => Boolean(config.wallets[wallet]?.enabled), [config]);
  const sizeFor = useCallback((wallet?: string | null) => resolveCopySize(config, wallet), [config]);

  return {
    config,
    ready,
    getWallet,
    isEnabled,
    setWallet,
    enableWallet,
    disableWallet,
    removeWallet,
    setGlobalDefaultSol,
    sizeFor,
  };
}
