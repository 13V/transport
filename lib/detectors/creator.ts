import { getAddressTransactions, getTokenTransactions } from '../helius-client';
import { PUMP_PROGRAM_ID_STR } from '../solana';
import type { TokenInsiderReport } from '../types';

export interface CreatorInfo {
  address: string;
  fundedWallets: string[];
  initialSolSent: number;
}

/**
 * Detect the creator wallet and wallets it directly funded
 * Strategy: Find Pump.fun create transactions, extract creator authority,
 * then trace SOL outflows in the first 60 seconds post-launch
 */
export async function detectCreator(mint: string): Promise<CreatorInfo | null> {
  try {
    // Fetch transactions for the token itself
    const txs = await getTokenTransactions(mint, 500);

    // Find the earliest transaction (likely creation)
    const sortedTxs = txs.sort((a, b) => a.timestamp - b.timestamp);
    if (sortedTxs.length === 0) return null;

    const creationTx = sortedTxs[0];
    const creationTime = creationTx.timestamp;
    const creatorAddress = creationTx.signer;

    if (!creatorAddress) {
      return null;
    }

    // Fetch transactions from the creator wallet in the first 60 seconds
    const creatorTxs = await getAddressTransactions(creatorAddress, 200);

    const fundedWallets: string[] = [];
    let totalSent = 0;

    // Look for SOL transfers (withdrawals) in the first 60 seconds
    for (const tx of creatorTxs) {
      // Only look at transactions within 60 seconds of creation
      if (tx.timestamp > creationTime + 60) continue;

      // Check for SOL transfers (destination present indicates a transfer)
      if (tx.type === 'TRANSFER' && tx.destination && tx.amount && tx.amount > 0.5) {
        fundedWallets.push(tx.destination);
        totalSent += tx.amount;
      }
    }

    // Only return if we found at least one funded wallet
    if (fundedWallets.length > 0) {
      return {
        address: creatorAddress,
        fundedWallets: [...new Set(fundedWallets)], // Deduplicate
        initialSolSent: totalSent,
      };
    }

    // If no direct funding found, still return the creator
    return {
      address: creatorAddress,
      fundedWallets: [],
      initialSolSent: 0,
    };
  } catch (error) {
    console.error('Error detecting creator:', error);
    return null;
  }
}
