import { getTokenTransactions } from '../helius-client';
import type { SnipeBundle } from '../types';

/**
 * Detect early snipers and bundles
 * Strategy: Look for wallets buying in the first few blocks/slots,
 * and identify same-slot multi-wallet buys as likely bundles
 */
export async function detectSnipers(mint: string): Promise<SnipeBundle[]> {
  try {
    const txs = await getTokenTransactions(mint, 500);

    // Sort by slot to find earliest buys
    const sortedTxs = txs.sort((a, b) => a.slot - b.slot);
    if (sortedTxs.length === 0) return [];

    const firstSlot = sortedTxs[0].slot;
    const snipeWindow = 5; // Look in first 5 slots

    // Find transactions in the snipe window
    const snipeTxs = sortedTxs.filter((tx) => tx.slot <= firstSlot + snipeWindow);

    // Group by slot to find bundles
    const bySlot = new Map<number, typeof snipeTxs>();
    for (const tx of snipeTxs) {
      if (!bySlot.has(tx.slot)) {
        bySlot.set(tx.slot, []);
      }
      bySlot.get(tx.slot)!.push(tx);
    }

    // Find same-slot multi-wallet bundles
    const bundles: SnipeBundle[] = [];

    for (const [slot, txsInSlot] of bySlot.entries()) {
      // Look for same-slot buys from different signers
      const bySource = new Map<string, typeof txsInSlot>();

      for (const tx of txsInSlot) {
        const source = tx.signer || 'unknown';
        if (!bySource.has(source)) {
          bySource.set(source, []);
        }
        bySource.get(source)!.push(tx);
      }

      // If multiple wallets bought in the same slot, it's likely a bundle
      if (bySource.size >= 2) {
        const wallets = Array.from(bySource.keys());
        const avgAmount =
          txsInSlot.reduce((sum, tx) => sum + (tx.amount || 0), 0) / txsInSlot.length;

        // Confidence: higher with more wallets in the bundle
        const confidence = Math.min(bySource.size / 10, 1);

        bundles.push({
          wallets,
          slot,
          timestamp: txsInSlot[0]?.timestamp || 0,
          amountPerWallet: avgAmount,
          confidence,
        });
      }
    }

    // Also flag single-wallet early buys with <1 SOL (likely snipe bots)
    for (const tx of snipeTxs) {
      const amount = tx.amount || 0;
      if (amount < 1 && amount > 0 && tx.signer) {
        // Check if this wallet is already in a bundle
        const inBundle = bundles.some((b) => b.wallets.includes(tx.signer!));
        if (!inBundle) {
          bundles.push({
            wallets: [tx.signer],
            slot: tx.slot,
            timestamp: tx.timestamp,
            amountPerWallet: amount,
            confidence: 0.7, // Medium confidence for single-wallet snipes
          });
        }
      }
    }

    return bundles.sort((a, b) => a.slot - b.slot);
  } catch (error) {
    console.error('Error detecting snipers:', error);
    return [];
  }
}
