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

  it('uses the DexScreener oracle as the current price when the on-chain price agrees (no override)', async () => {
    // On-chain last buy matches the oracle (within the noise band) → the oracle is
    // the current price and the snapshot mcap is left as-is.
    mockOracle.mockResolvedValue(new Map([['MINT', 2]])); // current = 2 SOL/token
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 2, marketCapUsd: 20000 }),
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

  // --- FIX B: ONE consistent source per token (direction + mcap can't disagree) ---

  it('tags the DexScreener (listed) source and derives a consistent entry mcap', async () => {
    mockOracle.mockResolvedValue(new Map([['MINT', 2]]));
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 2, marketCapUsd: 20000 }),
    ]);
    expect(b.priceChangeSource).toBe('dexscreener');
    // % and entry mcap both come from DexScreener → same direction. +100% means
    // entry mcap < current mcap (10000 < 20000): the arrow MUST point up, matching.
    expect(b.priceChangeSincePct).toBe(100);
    expect(b.entryMarketCapUsd).toBe(10000);
    expect(b.priceChangeSincePct! >= 0).toBe(b.entryMarketCapUsd! <= b.marketCapUsd!);
  });

  it('tags the on-chain source and SUPPRESSES the entry mcap when un-listed', async () => {
    // DexScreener has no price (un-listed) but DexScreener mcap is somehow present
    // (stale). The OLD bug scaled that mcap by the on-chain ratio, producing a USD
    // pair whose arrow could disagree with the %. We must NOT fabricate it now.
    mockOracle.mockResolvedValue(new Map());
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 0.44, marketCapUsd: 55100 }),
    ]);
    expect(b.priceChangeSource).toBe('onchain');
    expect(b.priceChangeSincePct).toBe(-56); // (0.44-1)/1
    // No source-mismatched USD pair: entry mcap stays null so the card shows the
    // % WITHOUT a "$entry → $now" pair that could point the wrong way.
    expect(b.entryMarketCapUsd).toBeNull();
  });

  it('SAME-DIRECTION guarantee: a down % never yields an up mcap pair (the $55k→$24k/+0.0% bug)', async () => {
    // Listed token that is DOWN: oracle current < entry. Both the % and the entry
    // mcap come from DexScreener, so the entry mcap is ABOVE the current mcap
    // (arrow down) — exactly matching the negative %.
    mockOracle.mockResolvedValue(new Map([['MINT', 0.44]]));
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 0.9, marketCapUsd: 24300 }),
    ]);
    expect(b.priceChangeSource).toBe('dexscreener');
    expect(b.priceChangeSincePct).toBeLessThan(0);
    // entry mcap (55227) > current mcap (24300): arrow points DOWN, same as the %.
    expect(b.entryMarketCapUsd!).toBeGreaterThan(b.marketCapUsd!);
  });

  // --- FRESHNESS: rescale the stale DexScreener mcap onto the fresh on-chain price ---

  it('rescales the displayed current mcap/price onto the fresher on-chain last buy (the $38k→$60k staleness bug)', async () => {
    // DexScreener oracle/mcap snapshot is STALE (up to 2 min): it still prices the
    // token at the entry-era $38k. The on-chain last buy is ~10s fresh and already
    // 1.5789× higher. The card's CURRENT mcap must track the fresh price (~$60k),
    // not the stale $38k.
    mockOracle.mockResolvedValue(new Map([['MINT', 1]])); // stale oracle: 1 SOL/token
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 1.5789, marketCapUsd: 38000 }),
    ]);
    expect(b.priceChangeSource).toBe('dexscreener');
    // current mcap rescaled by 1.5789× → ~60000 (was the stale 38000).
    expect(b.marketCapUsd).toBe(Math.round(38000 * 1.5789));
    // % is entry→current on the FRESH price: (1.5789 - 1)/1 = +57.89%.
    expect(b.priceChangeSincePct).toBeCloseTo(57.89, 1);
  });

  it('keeps current mcap, %, and entry mcap on ONE consistent basis after the rescale', async () => {
    mockOracle.mockResolvedValue(new Map([['MINT', 1]]));
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 0.5, lastBuyPriceSol: 2, marketCapUsd: 30000 }),
    ]);
    // Up move → current mcap ABOVE entry mcap, multiplier matches the % direction.
    expect(b.priceChangeSincePct! > 0).toBe(true);
    expect(b.entryMarketCapUsd!).toBeLessThan(b.marketCapUsd!);
    // mcMultiple (current/entry mcap) === price multiple (current/entry price).
    const mcMultiple = b.marketCapUsd! / b.entryMarketCapUsd!;
    expect(mcMultiple).toBeCloseTo(2 / 0.5, 5); // 4×
    // Entry mcap is anchored to the DexScreener basis (mcap*entry/oracle), so it is
    // INDEPENDENT of the on-chain rescale: 30000 * 0.5 / 1 = 15000.
    expect(b.entryMarketCapUsd).toBe(15000);
  });

  it('does NOT perturb the current mcap when on-chain ≈ oracle (within the noise band)', async () => {
    // On-chain within 1% of the oracle → settled token; leave the snapshot as-is so
    // quote jitter never re-prices a card. Behaviour stays byte-identical to before.
    mockOracle.mockResolvedValue(new Map([['MINT', 1]]));
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 1.005, marketCapUsd: 50000 }),
    ]);
    expect(b.marketCapUsd).toBe(50000); // untouched
    expect(b.priceChangeSincePct).toBe(0); // uses the oracle current (== entry)
  });

  it('leaves the current mcap untouched on the un-listed (on-chain) path', async () => {
    // No oracle price → on-chain source. We do NOT rescale a DexScreener mcap by an
    // on-chain ratio (that mismatch is the bug we eliminate), so any stale mcap is
    // left as-is and the entry mcap stays null.
    mockOracle.mockResolvedValue(new Map());
    const [b] = await annotateLivePriceChange([
      burst({ firstBuyPriceSol: 1, lastBuyPriceSol: 2, marketCapUsd: 12345 }),
    ]);
    expect(b.priceChangeSource).toBe('onchain');
    expect(b.marketCapUsd).toBe(12345); // untouched
    expect(b.entryMarketCapUsd).toBeNull();
  });
});

// --- FIX B: large-move multiplier formatting (mirrors LiveFeed.tsx) ---
// formatSinceMove lives in the client component; this replicates its contract so
// the readable-form logic is unit-covered: large gains → "<n>×", else signed %.
const LARGE_GAIN_PCT = 1000;
function formatMultiple(mult: number): string {
  return mult >= 100 ? `${Math.round(mult)}×` : `${mult.toFixed(1)}×`;
}
function formatSinceMove(pct: number | null): { text: string; up: boolean; isMultiple: boolean } | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  const up = pct >= 0;
  if (pct >= LARGE_GAIN_PCT) {
    return { text: formatMultiple(1 + pct / 100), up: true, isMultiple: true };
  }
  return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, up, isMultiple: false };
}

describe('formatSinceMove (large-move multiplier)', () => {
  it('renders an absurd bonding-curve gain as a clean whole multiplier', () => {
    // +264691.3% → 2648× (1 + 264691.3/100 = 2647.913 → rounded 2648), not a
    // six-digit percent.
    const m = formatSinceMove(264691.3)!;
    expect(m.isMultiple).toBe(true);
    expect(m.up).toBe(true);
    expect(m.text).toBe('2648×');
    expect(m.text).not.toContain('%');
  });

  it('uses one decimal for mid-range multiples (11–99×)', () => {
    // +4900% → 50× exactly; +1150% → 12.5×.
    expect(formatSinceMove(4900)!.text).toBe('50.0×');
    expect(formatSinceMove(1150)!.text).toBe('12.5×');
  });

  it('keeps small/medium moves as a normal signed %', () => {
    expect(formatSinceMove(42)).toMatchObject({ text: '+42.0%', isMultiple: false, up: true });
    expect(formatSinceMove(-12.5)).toMatchObject({ text: '-12.5%', isMultiple: false, up: false });
    // 999% stays a % (below the 1000% multiplier threshold).
    expect(formatSinceMove(999)!.isMultiple).toBe(false);
  });

  it('returns null for missing/non-finite input', () => {
    expect(formatSinceMove(null)).toBeNull();
    expect(formatSinceMove(NaN)).toBeNull();
  });
});
