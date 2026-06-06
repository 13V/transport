'use client';

/* =========================================================================
   INJECTED-WALLET HOOK (no @solana/wallet-adapter, zero new deps)

   Talks directly to the standard injected provider (`window.solana`, exposed
   by Phantom / Solflare / Backpack and friends). Exposes a tiny surface:

     { address, connect(), disconnect(), connecting }

   The connected address is persisted to localStorage so a session survives a
   page reload (we eagerly re-attach to the provider if it's already trusted).
   Fully SSR-guarded: every `window`/`localStorage` access is behind a runtime
   check, so importing this on the server is a no-op.
   ========================================================================= */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'gating.wallet.address';

// Minimal shape of the injected Solana provider we depend on.
interface InjectedSolana {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  on?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}

function getProvider(): InjectedSolana | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { solana?: InjectedSolana };
  return w.solana ?? null;
}

function readStored(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(addr: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (addr) window.localStorage.setItem(STORAGE_KEY, addr);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* localStorage unavailable (private mode / disabled) — non-fatal. */
  }
}

export interface UseWallet {
  /** Connected wallet base58 address, or null when disconnected. */
  address: string | null;
  /** Prompt the injected wallet to connect. No-op if no provider present. */
  connect: () => Promise<void>;
  /** Disconnect + clear the persisted address. */
  disconnect: () => Promise<void>;
  /** True while a connect request is in flight. */
  connecting: boolean;
  /** Whether an injected provider was detected (false → no wallet installed). */
  hasProvider: boolean;
}

export function useWallet(): UseWallet {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [hasProvider, setHasProvider] = useState(false);

  // Mount: detect provider, eagerly re-attach if previously trusted, and
  // subscribe to account/disconnect events.
  useEffect(() => {
    const provider = getProvider();
    setHasProvider(!!provider);
    if (!provider) return;

    let alive = true;

    // Optimistically reflect the persisted address so the UI doesn't flicker,
    // then confirm against the provider's trusted-connection state.
    const stored = readStored();
    if (stored) setAddress(stored);

    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => {
        if (!alive) return;
        const addr = res?.publicKey?.toString() ?? null;
        setAddress(addr);
        writeStored(addr);
      })
      .catch(() => {
        // Not trusted yet — drop any stale persisted address.
        if (!alive) return;
        if (stored) {
          setAddress(null);
          writeStored(null);
        }
      });

    const onAccountChanged = (pk: { toString(): string } | null) => {
      const addr = pk ? pk.toString() : null;
      setAddress(addr);
      writeStored(addr);
    };
    const onDisconnect = () => {
      setAddress(null);
      writeStored(null);
    };

    provider.on?.('accountChanged', onAccountChanged);
    provider.on?.('disconnect', onDisconnect);

    return () => {
      alive = false;
      provider.removeListener?.('accountChanged', onAccountChanged);
      provider.removeListener?.('disconnect', onDisconnect);
    };
  }, []);

  const connect = useCallback(async () => {
    const provider = getProvider();
    if (!provider) {
      // No wallet extension — surface nothing destructive; caller can prompt.
      console.warn('[GATING] No injected Solana wallet found.');
      return;
    }
    setConnecting(true);
    try {
      const res = await provider.connect();
      const addr = res?.publicKey?.toString() ?? null;
      setAddress(addr);
      writeStored(addr);
    } catch (err) {
      // User rejected / popup closed — non-fatal.
      console.warn('[GATING] wallet connect rejected:', err);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const provider = getProvider();
    try {
      await provider?.disconnect();
    } catch {
      /* ignore */
    }
    setAddress(null);
    writeStored(null);
  }, []);

  return { address, connect, disconnect, connecting, hasProvider };
}
