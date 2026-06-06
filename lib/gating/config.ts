/* =========================================================================
   TOKEN-GATING CONFIG (Phase 0 scaffolding)

   Reads the gating feature flag + token parameters from the environment.
   Everything here is DISABLED by default: until the project token launches
   and `NEXT_PUBLIC_GATING_ENABLED=true` (with a real mint set), gating is a
   no-op and the app behaves exactly as it does today.

   These three vars are the entire env contract:
     NEXT_PUBLIC_GATING_ENABLED   "true" to turn gating ON (default: off)
     NEXT_PUBLIC_GATE_TOKEN_MINT  the project token mint (empty until launch)
     NEXT_PUBLIC_GATE_MIN_BALANCE min UI-token balance for Pro (default: 0)

   NEXT_PUBLIC_* so the same values are readable on both server and client.
   ========================================================================= */

export interface GatingConfig {
  /** Raw value of NEXT_PUBLIC_GATING_ENABLED parsed to a boolean. */
  enabled: boolean;
  /** The gate token's mint address. Empty string until the token launches. */
  tokenMint: string;
  /** Minimum UI-amount balance of the gate token required for Pro access. */
  minBalance: number;
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  return v.trim().toLowerCase() === 'true' || v.trim() === '1';
}

function parseNum(v: string | undefined, fallback: number): number {
  if (v == null || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Typed snapshot of the gating environment. Computed once at module load;
 * NEXT_PUBLIC_* values are inlined at build time so this is stable.
 */
export const gatingConfig: GatingConfig = {
  enabled: parseBool(process.env.NEXT_PUBLIC_GATING_ENABLED),
  tokenMint: (process.env.NEXT_PUBLIC_GATE_TOKEN_MINT || '').trim(),
  minBalance: parseNum(process.env.NEXT_PUBLIC_GATE_MIN_BALANCE, 0),
};

/**
 * Single source of truth for "is token gating live right now?".
 *
 * Returns false unless BOTH:
 *   - the flag is explicitly enabled, AND
 *   - a non-empty token mint is configured.
 *
 * This guarantees production stays fully unlocked until launch: even if
 * someone flips the flag without setting a mint, gating stays off rather
 * than locking everyone out against a meaningless/empty mint.
 */
export function isGatingEnabled(): boolean {
  return gatingConfig.enabled && gatingConfig.tokenMint.length > 0;
}
