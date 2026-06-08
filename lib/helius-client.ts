import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { guardHeliusPage, recordSpend } from './indexer/helius-budget';

let heliusApiKey: string | null = null;
let keyResolved = false;

/**
 * Resolve the Helius API key from the environment.
 * Returns null if not set — does NOT throw, so the app degrades
 * gracefully to public RPC instead of crashing.
 */
export function initHelius(): string | null {
  if (!keyResolved) {
    heliusApiKey = process.env.HELIUS_API_KEY || null;
    keyResolved = true;
    if (!heliusApiKey) {
      console.warn(
        '[HELIUS] HELIUS_API_KEY not set — falling back to public Solana RPC (slower, rate-limited).'
      );
    }
  }
  return heliusApiKey;
}

function getHeliusUrl(): string {
  const key = initHelius();
  // Prefer the paid Helius RPC when a key is available (higher rate limits,
  // more reliable). Fall back to public Solana RPC when no key is configured.
  if (key) {
    return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  }
  return 'https://api.mainnet-beta.solana.com';
}

function getHeliusEnhancedUrl(): string {
  return `https://api-mainnet.helius-rpc.com/v0`;
}

// Per-RPC credit estimate for the daily budget guard. The Enhanced API pages
// cost 100 credits each; a single JSON-RPC call is cheaper, but charging a flat
// estimate keeps /api/analyze's many small calls bounded by the same global cap
// as the indexer/swap fetchers (lib/indexer/helius-budget.ts).
const RPC_CREDIT_EST = 10;

// Message thrown by the budget guard (and mirrored here) when the daily Helius
// credit cap is reached. Exported so callers (e.g. /api/analyze) can tell a
// budget-exhaustion failure apart from a genuine not-found and surface a clear
// 503 instead of a misleading 404.
export const HELIUS_BUDGET_EXHAUSTED_MESSAGE = 'Helius daily credit cap reached';

/** True when `err` is the daily-budget-cap-reached error from the guard. */
export function isHeliusBudgetExhausted(err: unknown): boolean {
  return err instanceof Error && err.message === HELIUS_BUDGET_EXHAUSTED_MESSAGE;
}

async function heliusRpc(method: string, params: any[] = [], retries = 3): Promise<any> {
  // Global daily-budget circuit breaker: once the Helius credit cap is reached,
  // fail closed so /api/analyze can't keep spending. Callers already degrade
  // gracefully (return []/null) on a thrown error.
  if (!(await guardHeliusPage(RPC_CREDIT_EST))) {
    throw new Error(HELIUS_BUDGET_EXHAUSTED_MESSAGE);
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await axios.post(getHeliusUrl(), {
        jsonrpc: '2.0',
        id: '1',
        method,
        params,
      }, { timeout: 10000 });

      if (response.data.error) {
        throw new Error(response.data.error.message || 'RPC error');
      }

      await recordSpend(RPC_CREDIT_EST); // call succeeded -> record the spend
      return response.data.result;
    } catch (error) {
      if (attempt === retries - 1) {
        console.error(`Helius RPC error (${method}):`, error);
        throw error;
      }
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`RPC retry ${attempt + 1}/${retries} after ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export interface HolderData {
  address: string;
  amount: number;
  decimals: number;
}

export interface TransactionData {
  signature: string;
  slot: number;
  timestamp: number;
  fee: number;
  status: 'success' | 'failed';
  type: string;
  description: string;
  source?: string;
  destination?: string;
  amount?: number;
  signer?: string;
}

// Fetch top holders for a token
export async function getTopHolders(mint: string, limit = 100): Promise<HolderData[]> {
  initHelius();

  try {
    // Use getTokenLargestAccounts to get top holders
    const response = await heliusRpc('getTokenLargestAccounts', [mint]);

    if (!response || !response.value) {
      return [];
    }

    const holders: HolderData[] = (response.value || [])
      .slice(0, limit)
      .map((account: any) => ({
        address: account.address,
        amount: account.uiAmount || 0,
        decimals: 6, // Default, could be fetched from mint
      }));

    return holders;
  } catch (error) {
    // Let a daily-budget-cap exhaustion propagate so callers can distinguish it
    // from "token has no holders" (an empty list) and return a clear 503.
    if (isHeliusBudgetExhausted(error)) throw error;
    console.error('Error fetching holders:', error);
    return [];
  }
}

// Fetch transactions for an address using standard RPC
export async function getAddressTransactions(
  address: string,
  limit = 100
): Promise<TransactionData[]> {
  initHelius();

  try {
    // Use getSignaturesForAddress to get transaction signatures
    const signatures = await heliusRpc('getSignaturesForAddress', [address, { limit }]);

    if (!signatures || !Array.isArray(signatures)) {
      return [];
    }

    // Fetch details for top transactions
    const txDetails: TransactionData[] = [];

    for (const sig of signatures.slice(0, limit)) {
      try {
        const txData = await heliusRpc('getTransaction', [sig.signature, { maxSupportedTransactionVersion: 0 }]);

        if (txData) {
          txDetails.push({
            signature: sig.signature,
            slot: txData.slot || 0,
            timestamp: txData.blockTime || 0,
            fee: txData.transaction?.meta?.fee || 0,
            status: txData.transaction?.meta?.err ? 'failed' : 'success',
            type: 'TRANSFER',
            description: '',
            source: undefined,
            destination: undefined,
            amount: undefined,
            signer: undefined,
          });
        }
      } catch (e) {
        // Skip if we can't fetch details
        continue;
      }
    }

    return txDetails;
  } catch (error) {
    console.error('Error fetching address transactions:', error);
    return [];
  }
}

// Get parsed transactions for a specific token
export async function getTokenTransactions(
  mint: string,
  limit = 100
): Promise<TransactionData[]> {
  initHelius();

  try {
    // Fetch signatures for the mint
    const signatures = await heliusRpc('getSignaturesForAddress', [mint, { limit }]);

    if (!signatures || !Array.isArray(signatures)) {
      return [];
    }

    const txDetails: TransactionData[] = [];

    for (const sig of signatures.slice(0, limit)) {
      try {
        const txData = await heliusRpc('getTransaction', [sig.signature, { maxSupportedTransactionVersion: 0 }]);

        if (txData) {
          txDetails.push({
            signature: sig.signature,
            slot: txData.slot || 0,
            timestamp: txData.blockTime || 0,
            fee: txData.transaction?.meta?.fee || 0,
            status: txData.transaction?.meta?.err ? 'failed' : 'success',
            type: 'TRANSFER',
            description: '',
            source: undefined,
            destination: undefined,
            amount: undefined,
            signer: undefined,
          });
        }
      } catch (e) {
        continue;
      }
    }

    return txDetails;
  } catch (error) {
    console.error('Error fetching token transactions:', error);
    return [];
  }
}

// Get token metadata
export async function getTokenMetadata(mint: string) {
  initHelius();

  try {
    // Fetch token supply
    const supply = await heliusRpc('getTokenSupply', [mint]);

    return {
      name: 'Token',
      symbol: 'TKN',
      decimals: supply?.decimals || 6,
      supply: supply?.uiAmount || 0,
      holders: 0,
      created: Date.now(),
    };
  } catch (error) {
    // Let a daily-budget-cap exhaustion propagate so callers can distinguish it
    // from "token not found" (null) and return a clear 503 instead of a 404.
    if (isHeliusBudgetExhausted(error)) throw error;
    console.error('Error fetching token metadata:', error);
    return null;
  }
}
