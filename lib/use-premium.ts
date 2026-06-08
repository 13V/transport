'use client';

/**
 * use-premium — minimal client hook for web premium status.
 *
 * The SERVER is the source of truth: this hook just polls GET /api/access/status
 * with the browser's stable web_session id and reflects the result. It NEVER
 * decides premium locally from a balance read — that would be spoofable.
 *
 * The web_session id is a random opaque token kept in localStorage; it's the
 * same id the /access page binds to the verified wallet, so once the user signs
 * in their wallet and holds >= the threshold, this flips to premium.
 *
 * Resilient: any fetch error → { premium:false } (fail closed), except when the
 * server reports monetization isn't configured, in which case premium is true
 * (gate-open) — matching the server contract.
 */

import { useCallback, useEffect, useState } from 'react';

const SESSION_KEY = 'access.web_session';

/** Read (or lazily create) the stable per-browser web session id. */
export function getWebSession(): string {
  if (typeof window === 'undefined') return '';
  try {
    let s = window.localStorage.getItem(SESSION_KEY);
    if (!s) {
      const rand =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36);
      s = `ws_${rand}`;
      window.localStorage.setItem(SESSION_KEY, s);
    }
    return s;
  } catch {
    return '';
  }
}

export interface PremiumState {
  premium: boolean;
  loading: boolean;
  configured: boolean;
  reason: string | null;
  balance: number | null;
  required: number | null;
  /** Re-check status now (e.g. after the user verifies their wallet). */
  refresh: () => void;
}

export function usePremium(): PremiumState {
  const [premium, setPremium] = useState(false);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [reason, setReason] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [required, setRequired] = useState<number | null>(null);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      const session = getWebSession();
      const res = await fetch(`/api/access/status?session=${encodeURIComponent(session)}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      setPremium(Boolean(data?.premium));
      setConfigured(data?.configured !== false);
      setReason(typeof data?.reason === 'string' ? data.reason : null);
      setBalance(typeof data?.balance === 'number' ? data.balance : null);
      setRequired(typeof data?.required === 'number' ? data.required : null);
    } catch {
      // Fail closed.
      setPremium(false);
      setReason('fetch-error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return { premium, loading, configured, reason, balance, required, refresh: check };
}
