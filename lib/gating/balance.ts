/* =========================================================================
   GATE-TOKEN BALANCE READER (server-safe)

   Given a wallet address, return its on-chain UI-amount balance of the gate
   token (NEXT_PUBLIC_GATE_TOKEN_MINT). Uses the same Helius/RPC plumbing the
   rest of the app relies on (`initHelius()` resolves the key; we fall back to
   public Solana RPC when no key is set).

   Guarantees:
     - Server-safe: no `window`, no browser APIs.
     - Resilient: returns 0 on ANY error (bad address, RPC down, no mint, …).
     - No fake data: the number is a real `getTokenAccountsByOwner` read, or 0.
   ========================================================================= */

import axios from 'axios';
import { initHelius } from '../helius-client';
import { gatingConfig } from './config';

// SPL Token program — owner program for `getTokenAccountsByOwner`.
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * Mirror of lib/helius-client's URL selection: prefer the paid Helius RPC when
 * a key is configured, else fall back to public mainnet RPC. Kept local because
 * the helper there is not exported.
 */
function rpcUrl(): string {
  const key = initHelius();
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await axios.post(
    rpcUrl(),
    { jsonrpc: '2.0', id: '1', method, params },
    { timeout: 10000 }
  );
  if (res.data?.error) {
    throw new Error(res.data.error.message || 'RPC error');
  }
  return res.data?.result;
}

/**
 * Fetch the UI-amount balance of the gate token held by `owner`.
 *
 * @param owner  the wallet address to check.
 * @param mint   optional override; defaults to the configured gate mint.
 * @returns      the UI-amount as a number, summed across token accounts; 0 on
 *               any error or when no mint is configured.
 */
export async function getGateTokenBalance(
  owner: string,
  mint: string = gatingConfig.tokenMint
): Promise<number> {
  try {
    if (!owner || !mint) return 0;

    const result = await rpc('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);

    const accounts: any[] = result?.value ?? [];
    if (!Array.isArray(accounts) || accounts.length === 0) return 0;

    // A wallet can technically hold a mint across multiple token accounts; sum
    // their UI amounts for the true total balance.
    let total = 0;
    for (const acc of accounts) {
      const ui =
        acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof ui === 'number' && Number.isFinite(ui)) total += ui;
    }
    return total;
  } catch (err) {
    // Resilient by contract: never throw, never block access on an RPC hiccup.
    console.error('[GATING] getGateTokenBalance failed:', err);
    return 0;
  }
}

/**
 * Convenience: does this wallet meet the Pro threshold based on a real balance
 * read? Returns the balance and the derived isPro flag together so callers
 * make a single round-trip.
 */
export async function checkGateAccess(
  owner: string
): Promise<{ balance: number; isPro: boolean }> {
  const balance = await getGateTokenBalance(owner);
  return { balance, isPro: balance >= gatingConfig.minBalance };
}

// Re-exported for callers that want it without reaching into helius-client.
export { TOKEN_PROGRAM_ID };
