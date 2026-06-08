/**
 * TOKEN-BALANCE GATE
 *
 * Reads a wallet's real on-chain balance of the monetization gate token and
 * answers "does this wallet hold at least N?". Backs all three access gates:
 *   - Telegram alerts : hold >= TG_GATE_MIN_AMOUNT   (default 1,000,000)
 *   - Web premium     : hold >= TOKEN_GATE_MIN_AMOUNT (default   500,000)
 *
 * ENV CONTRACT
 *   TOKEN_GATE_MINT        the gate token mint. **If unset, gates are OPEN** —
 *                          holdsAtLeast() returns true so nothing breaks before
 *                          the token launches / monetization is configured.
 *   TG_GATE_MIN_AMOUNT     min UI-amount for Telegram alerts (default 1_000_000).
 *   TOKEN_GATE_MIN_AMOUNT  min UI-amount for web premium     (default   500_000).
 *
 * The actual on-chain read reuses lib/gating/balance.ts (getGateTokenBalance),
 * which sums uiAmount across the wallet's token accounts via Helius RPC
 * `getTokenAccountsByOwner` and returns 0 on any error (never fake data).
 *
 * Reads are cached ~60s per (wallet, mint) so a broadcast fan-out doesn't hit
 * RPC once per chat.
 */

import { getGateTokenBalance } from './gating/balance';

const CACHE_TTL_MS = 60_000;

/** Default thresholds (UI-amount, not raw). Overridable via env. */
export const DEFAULT_TG_MIN = 1_000_000;
export const DEFAULT_WEB_MIN = 500_000;

/** The configured gate mint, or '' when monetization isn't configured yet. */
export function gateMint(): string {
  return (process.env.TOKEN_GATE_MINT || '').trim();
}

/** True when a gate token mint is configured (otherwise gates are OPEN). */
export function isTokenGateConfigured(): boolean {
  return gateMint().length > 0;
}

function envAmount(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Telegram alert threshold (default 1,000,000). */
export function tgMinAmount(): number {
  return envAmount('TG_GATE_MIN_AMOUNT', DEFAULT_TG_MIN);
}

/** Web premium threshold (default 500,000). */
export function webMinAmount(): number {
  return envAmount('TOKEN_GATE_MIN_AMOUNT', DEFAULT_WEB_MIN);
}

interface CacheEntry {
  balance: number;
  at: number;
}
const balanceCache = new Map<string, CacheEntry>();

/**
 * Real UI-amount balance of `mint` held by `wallet`, cached ~60s. When no mint
 * is configured returns 0 (callers treat the gate as open via holdsAtLeast).
 */
export async function getTokenBalance(
  wallet: string,
  mint: string = gateMint()
): Promise<number> {
  const w = (wallet || '').trim();
  const m = (mint || '').trim();
  if (!w || !m) return 0;

  const cacheKey = `${m}:${w}`;
  const now = Date.now();
  const hit = balanceCache.get(cacheKey);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.balance;

  const balance = await getGateTokenBalance(w, m);
  balanceCache.set(cacheKey, { balance, at: now });
  return balance;
}

/**
 * Does `wallet` hold at least `amount` of the gate token?
 *
 * GATE-OPEN RULE: when TOKEN_GATE_MINT is unset the gate is treated as OPEN and
 * this returns true (so nothing is locked before monetization is configured).
 * An empty/invalid wallet always fails (false) when the gate IS configured.
 */
export async function holdsAtLeast(wallet: string, amount: number): Promise<boolean> {
  if (!isTokenGateConfigured()) return true; // gates open until configured
  const w = (wallet || '').trim();
  if (!w) return false;
  const balance = await getTokenBalance(w);
  return balance >= amount;
}

/** Clear the in-memory balance cache (test/debug). */
export function _clearTokenGateCache(): void {
  balanceCache.clear();
}
