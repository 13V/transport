'use client';

/* =========================================================================
   useGate — the one hook the UI consumes for token gating.

   Combines `useWallet` (injected provider) with a server-side balance check
   (/api/gate/balance) to expose:

     { connected, address, isPro, balance, loading, connect, disconnect,
       connecting, hasProvider, gatingEnabled }

   CRITICAL INVARIANT: when gating is disabled (flag off or no mint), this
   ALWAYS returns isPro: true and performs NO network calls — everything is
   unlocked exactly as production behaves today.
   ========================================================================= */

import { useCallback, useEffect, useState } from 'react';
import { isGatingEnabled } from './config';
import { useWallet } from './useWallet';

export interface UseGate {
  /** Whether a wallet is currently connected. */
  connected: boolean;
  /** Connected wallet address, or null. */
  address: string | null;
  /** Pro access. ALWAYS true while gating is disabled. */
  isPro: boolean;
  /** Real on-chain gate-token balance, or null when unknown / gating off. */
  balance: number | null;
  /** True while the balance check is in flight. */
  loading: boolean;
  /** True while a wallet connect is in flight. */
  connecting: boolean;
  /** Whether an injected wallet provider was detected. */
  hasProvider: boolean;
  /** Whether token gating is live (flag on AND mint set). */
  gatingEnabled: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useGate(): UseGate {
  const { address, connect, disconnect, connecting, hasProvider } = useWallet();
  const gatingEnabled = isGatingEnabled();

  // Default Pro=true so the unlocked path needs zero work and never flickers.
  const [isPro, setIsPro] = useState(true);
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    // Gating off → fully unlocked, no network, no state churn.
    if (!gatingEnabled) {
      setIsPro(true);
      setBalance(null);
      setLoading(false);
      return;
    }
    // Gating on but no wallet → not Pro until they connect.
    if (!address) {
      setIsPro(false);
      setBalance(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(
        `/api/gate/balance?address=${encodeURIComponent(address)}`,
        { cache: 'no-store' }
      );
      const json = await res.json();
      setIsPro(Boolean(json?.isPro));
      setBalance(typeof json?.balance === 'number' ? json.balance : 0);
    } catch {
      // Fail closed when gating is ON: an errored check is not Pro.
      setIsPro(false);
      setBalance(0);
    } finally {
      setLoading(false);
    }
  }, [gatingEnabled, address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    connected: !!address,
    address,
    isPro,
    balance,
    loading,
    connecting,
    hasProvider,
    gatingEnabled,
    connect,
    disconnect,
  };
}
