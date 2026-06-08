/**
 * Tests for the LIVE entry→now price-change annotation that powers the burst
 * card's hero % and "$entry → $now" market-cap pair.
 *
 * The bug: the card's % is derived (client-side) from GeckoTerminal OHLCV
 * candles, which don't exist for fresh pre-graduation pump.fun tokens, so the %
 * was stuck ("—" or 0%). The fix computes the % server-side from the burst's own
 * on-chain trade prices, preferring the DexScreener oracle when present and
 * falling back to the latest on-chain buy when the token isn't listed yet.
 */

// Mock the DexScreener SOL oracle so we control the "current listed price" path.
const mockOracle = jest.fn();
jest.mock('../prices/price-oracle', () => ({
  fetchTokenPricesSol: (...args: unknown[]) => mockOracle(...args),
}));

import { annotateLivePriceChange } from '../indexer/live-feed';
import type { LiveBurst } from '../indexer/live-bursts';

function burst(partial: Partial<LiveBurst>): LiveBurst {
  return {
    id: 'id',
    mint: 'MINT',
    buyers: 3,
    buyerWallets: 3,
    solTotal: 1,
    windowStart: new Date(0).toISOString(),
    windowEnd: new Date(0).toISOString(),
    sampleBuyers: [],
    wallets: [],
    side: 'buy',
    tiers: [],
    finalized: false,
    ...partial,
  };
}

describe('annotateLivePriceChange', () => {
  beforeEach(() => mockOracle.mockReset());

  it('uses the DexScreener oracle as the current price when the token is listed', async () => {
    mockOracle.mockResolvedValue(new Map([['MINT', 2]])); // current = 2 SOL/token
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 1.2, marketCapUsd: 20000 }),
    ]);
    // (2 - 1) / 1 = +100%
    expect(b.priceChangeSincePct).toBe(100);
    // entry mcap = current mcap * entry/current = 20000 * 1/2 = 10000
    expect(b.entryMarketCapUsd).toBe(10000);
  });

  it('falls back to the latest on-chain buy price for fresh, unlisted tokens', async () => {
    // Oracle has NO price for this mint (DexScreener hasn't listed it) — exactly
    // the fresh pump.fun case. The on-chain last buy must drive the %.
    mockOracle.mockResolvedValue(new Map());
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 1.5 }),
    ]);
    // (1.5 - 1) / 1 = +50%
    expect(b.priceChangeSincePct).toBe(50);
    // No DexScreener mcap → entry mcap stays null (nothing to scale).
    expect(b.entryMarketCapUsd).toBeNull();
  });

  it('moves as the latest on-chain buy price changes (not frozen at entry)', async () => {
    mockOracle.mockResolvedValue(new Map());
    const [down] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 2, lastBuyPriceSol: 1 }),
    ]);
    expect(down.priceChangeSincePct).toBe(-50);
  });

  it('returns null fields when there is no entry price', async () => {
    mockOracle.mockResolvedValue(new Map([['MINT', 5]]));
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: null, lastBuyPriceSol: 3 }),
    ]);
    expect(b.priceChangeSincePct).toBeNull();
    expect(b.entryMarketCapUsd).toBeNull();
  });

  it('returns null when neither the oracle nor an on-chain current price exists', async () => {
    mockOracle.mockResolvedValue(new Map());
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: null }),
    ]);
    expect(b.priceChangeSincePct).toBeNull();
  });

  it('is resilient when the oracle throws (uses the on-chain fallback)', async () => {
    mockOracle.mockRejectedValue(new Error('dexscreener down'));
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 1.25 }),
    ]);
    expect(b.priceChangeSincePct).toBe(25);
  });
});
