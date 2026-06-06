'use client';

/* =========================================================================
   GATE CONTROLS — topbar wallet-connect chip + Pro badge.

   Rendered ONLY when token gating is enabled (see AppShell). When the flag is
   off this component is never mounted, so production has zero visual change and
   no wallet hooks run.

   Uses existing design-system classes (.btn, .btn.sm, .badge.accent, .mono).
   ========================================================================= */

import React from 'react';
import { Wallet, Crown } from 'lucide-react';
import { useGate } from '@/lib/gating/useGate';
import * as f from '@/lib/format';

export default function GateControls() {
  const { connected, address, isPro, connecting, connect, disconnect, hasProvider } =
    useGate();

  if (!connected) {
    return (
      <button
        type="button"
        className="btn sm"
        onClick={connect}
        disabled={connecting}
        title={hasProvider ? 'Connect a Solana wallet' : 'No Solana wallet detected'}
      >
        <Wallet size={15} />
        <span>{connecting ? 'Connecting…' : 'Connect wallet'}</span>
      </button>
    );
  }

  return (
    <>
      {isPro && (
        <span className="badge accent" title="Pro access unlocked">
          <Crown size={12} /> Pro
        </span>
      )}
      <button
        type="button"
        className="btn sm ghost"
        onClick={disconnect}
        title="Disconnect wallet"
      >
        <Wallet size={15} />
        <span className="mono">{address ? f.short(address, 4, 4) : 'Wallet'}</span>
      </button>
    </>
  );
}
