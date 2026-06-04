import { getAddressTransactions } from '../helius-client';
import type { ClusterGroup, HolderInfo } from '../types';

interface WalletFundingSource {
  wallet: string;
  fundingSource: string;
  fundingAmount: number;
  confidence: number;
}

/**
 * Cluster holders by common funding source
 * Strategy: Trace SOL inflows to each holder, group by funding source
 * Identifies likely related wallets (same entity, bundle, bot cluster)
 */
export async function detectClusters(holders: HolderInfo[]): Promise<ClusterGroup[]> {
  try {
    // For performance, limit to top 100 holders
    const topHolders = holders.slice(0, 100);

    // Fetch funding sources for each holder
    const fundingSources = await Promise.all(
      topHolders.map((holder) => getFundingSource(holder.address))
    );

    // Group by funding source
    const clusters = new Map<string, WalletFundingSource[]>();

    for (const source of fundingSources) {
      if (!source) continue;
      if (!clusters.has(source.fundingSource)) {
        clusters.set(source.fundingSource, []);
      }
      clusters.get(source.fundingSource)!.push(source);
    }

    // Convert to ClusterGroup format, filter by cluster size and confidence
    const result: ClusterGroup[] = [];

    for (const [fundingSource, wallets] of clusters.entries()) {
      // Require at least 2 wallets per cluster to be interesting
      if (wallets.length < 2) continue;

      // Calculate confidence based on how consistent the funding pattern is
      const avgConfidence = wallets.reduce((sum, w) => sum + w.confidence, 0) / wallets.length;
      if (avgConfidence < 0.5) continue; // Skip low-confidence clusters

      const totalHoldings = wallets.reduce((sum, w) => sum + w.fundingAmount, 0);

      // Estimate entity size
      let size: 'tiny' | 'small' | 'medium' | 'large' = 'tiny';
      if (totalHoldings > 100) size = 'small';
      if (totalHoldings > 1000) size = 'medium';
      if (totalHoldings > 10000) size = 'large';

      result.push({
        fundingSource,
        wallets: wallets.map((w) => w.wallet),
        totalHoldings,
        estimatedEntitySize: size,
        confidence: Math.min(avgConfidence, 1),
      });
    }

    // Sort by total holdings
    return result.sort((a, b) => b.totalHoldings - a.totalHoldings);
  } catch (error) {
    console.error('Error detecting clusters:', error);
    return [];
  }
}

/**
 * Trace a wallet's primary funding source
 * Returns the SOL source address if found
 */
async function getFundingSource(
  walletAddress: string
): Promise<WalletFundingSource | null> {
  try {
    const txs = await getAddressTransactions(walletAddress, 50);

    // Look for incoming SOL transfers (deposits)
    const incomingTxs = txs
      .filter((tx) => tx.type === 'TRANSFER' && tx.destination === walletAddress && tx.amount)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (incomingTxs.length === 0) {
      return null;
    }

    // Use the first (earliest) significant transfer as the funding source
    const fundingTx = incomingTxs[0];
    const fundingSource = fundingTx.source || 'unknown';
    const fundingAmount = fundingTx.amount || 0;

    // Confidence: higher if amount is >0.5 SOL (likely intentional funding)
    const confidence = fundingAmount >= 0.5 ? 0.9 : 0.6;

    return {
      wallet: walletAddress,
      fundingSource,
      fundingAmount,
      confidence,
    };
  } catch (error) {
    console.error(`Error getting funding source for ${walletAddress}:`, error);
    return null;
  }
}
