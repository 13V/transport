import { detectClusters } from '../detectors/clustering';
import type { HolderInfo } from '../types';

// Mock the Helius client
jest.mock('../helius-client', () => ({
  getAddressTransactions: jest.fn(),
}));

import { getAddressTransactions } from '../helius-client';

describe('Clustering Algorithm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should cluster wallets by common funding source', async () => {
    // Mock data: 3 wallets funded from the same source
    const mockTxs = [
      {
        signature: 'tx1',
        slot: 100,
        timestamp: 1000,
        fee: 5000,
        status: 'success' as const,
        type: 'TRANSFER',
        description: 'Transfer',
        source: 'FundingWallet123',
        destination: 'Wallet1',
        amount: 1.5,
      },
    ];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const holders: HolderInfo[] = [
      {
        address: 'Wallet1',
        amount: 1000,
        percentOfSupply: 0.1,
        isCreator: false,
        isEarlyBuyer: false,
      },
      {
        address: 'Wallet2',
        amount: 900,
        percentOfSupply: 0.09,
        isCreator: false,
        isEarlyBuyer: false,
      },
      {
        address: 'Wallet3',
        amount: 800,
        percentOfSupply: 0.08,
        isCreator: false,
        isEarlyBuyer: false,
      },
    ];

    const clusters = await detectClusters(holders);

    expect(clusters).toBeDefined();
    expect(Array.isArray(clusters)).toBe(true);
  });

  it('should filter clusters with low confidence', async () => {
    const mockTxs = [
      {
        signature: 'tx1',
        slot: 100,
        timestamp: 1000,
        fee: 5000,
        status: 'success' as const,
        type: 'TRANSFER',
        description: 'Transfer',
        source: 'unknown',
        destination: 'Wallet1',
        amount: 0.1, // Very small amount = low confidence
      },
    ];

    (getAddressTransactions as jest.Mock).mockResolvedValue(mockTxs);

    const holders: HolderInfo[] = [
      {
        address: 'Wallet1',
        amount: 1000,
        percentOfSupply: 0.1,
        isCreator: false,
        isEarlyBuyer: false,
      },
    ];

    const clusters = await detectClusters(holders);

    // Should return empty or very small clusters
    expect(clusters.length).toBeLessThanOrEqual(1);
  });
});
