/**
 * SEED WALLET LOADER
 *
 * Resolves the curated set of alpha wallet addresses to deep-scan, merging two
 * sources so the list can be managed in code OR purely from the environment:
 *
 *   1. SEED_WALLETS env var — comma / space / newline separated base58 addresses
 *      (set in Vercel; lets you change the list without a deploy).
 *   2. ./seed-wallet-list.ts — addresses committed to the repo.
 *
 * Both are validated as plausible base58 Solana addresses and de-duplicated.
 */

import SEED_WALLET_LIST from './seed-wallet-list';

// Solana addresses are base58-encoded 32-byte keys → 32–44 chars, no 0/O/I/l.
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function parseEnvWallets(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The de-duplicated, validated list of seed wallets from all sources.
 */
export function getSeedWallets(): string[] {
  const candidates = [...SEED_WALLET_LIST, ...parseEnvWallets(process.env.SEED_WALLETS)];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const addr of candidates) {
    if (!BASE58_ADDRESS.test(addr) || seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

/** Where a wallet's seed entry came from — written to wallet_stats.seed_source. */
export const SEED_SOURCE = 'gmgn';
