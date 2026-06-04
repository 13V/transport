import axios from 'axios';
import { PublicKey } from '@solana/web3.js';

let heliusApiKey: string | null = null;

export function initHelius(): string {
  if (!heliusApiKey) {
    heliusApiKey = process.env.HELIUS_API_KEY || null;
    if (!heliusApiKey) {
      throw new Error('HELIUS_API_KEY environment variable not set');
    }
  }
  return heliusApiKey;
}

function getHeliusUrl(): string {
  const key = initHelius();
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

async function heliusRpc(method: string, params: any[] = []): Promise<any> {
  try {
    const response = await axios.post(getHeliusUrl(), {
      jsonrpc: '2.0',
      id: '1',
      method,
      params,
    });

    if (response.data.error) {
      throw new Error(response.data.error.message || 'RPC error');
    }

    return response.data.result;
  } catch (error) {
    console.error(`Helius RPC error (${method}):`, error);
    throw error;
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
    console.error('Error fetching token metadata:', error);
    return null;
  }
}
