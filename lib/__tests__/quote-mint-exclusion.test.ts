import { parseHeliusSwaps } from '../helius/parse-swap';
import { isQuoteMint } from '../quote-mints';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEME = '7xKXtg2CW3741Cv1AbcDeFgHiJkLmNoPqRsTuVwXyZ12'; // arbitrary non-quote mint
const WALLET = '4ej728KiCeLuuTaXhZb8Gef5G3bVrPpi3aUcw2dKhLPU';

// Minimal Helius enhanced-tx with one events.swap leg.
const tx = (tokenMint: string, side: 'buy' | 'sell') => ({
  signature: 'sig1',
  timestamp: 1_700_000_000,
  feePayer: WALLET,
  events: {
    swap: side === 'buy'
      ? { nativeInput: { account: WALLET, amount: 2_000_000_000 }, tokenOutputs: [{ userAccount: WALLET, mint: tokenMint, tokenAmount: 1000 }] }
      : { nativeOutput: { account: WALLET, amount: 2_000_000_000 }, tokenInputs: [{ userAccount: WALLET, mint: tokenMint, tokenAmount: 1000 }] },
  },
});

describe('quote-mint exclusion', () => {
  it('flags stablecoins / SOL derivatives as quote mints', () => {
    expect(isQuoteMint(USDC)).toBe(true);
    expect(isQuoteMint(WSOL)).toBe(true);
    expect(isQuoteMint(MEME)).toBe(false);
    expect(isQuoteMint(null)).toBe(false);
  });

  it('does NOT ingest a SOL→USDC swap as buying the USDC token', () => {
    const rows = parseHeliusSwaps([tx(USDC, 'buy')]);
    expect(rows.find((r) => r.token_mint === USDC)).toBeUndefined();
  });

  it('does NOT ingest a USDC→SOL swap as selling the USDC token', () => {
    const rows = parseHeliusSwaps([tx(USDC, 'sell')]);
    expect(rows.find((r) => r.token_mint === USDC)).toBeUndefined();
  });

  it('still ingests a real token buy', () => {
    const rows = parseHeliusSwaps([tx(MEME, 'buy')]);
    expect(rows.find((r) => r.token_mint === MEME && r.trade_type === 'BUY')).toBeTruthy();
  });
});

describe('vault-funded fill / dust floor', () => {
  // Jupiter DCA / limit-order fill: tokens arrive at the wallet, but payment
  // leaves the PROGRAM's vault — the wallet's own SOL movement is fee dust.
  // Ingesting it would record price = dust/amount (~100-1000x low) and poison
  // burst baselines and wallet PnL.
  const vaultFill = {
    signature: 'sig2',
    timestamp: 1_700_000_000,
    feePayer: WALLET,
    tokenTransfers: [
      { fromUserAccount: 'VauLt111111111111111111111111111111111111111', toUserAccount: WALLET, mint: MEME, tokenAmount: 680_000 },
    ],
    nativeTransfers: [
      { fromUserAccount: WALLET, toUserAccount: 'Fee1111111111111111111111111111111111111111', amount: 3_700_000 }, // 0.0037 SOL dust
    ],
  };

  it('does NOT ingest a vault-funded fill priced off fee dust', () => {
    expect(parseHeliusSwaps([vaultFill])).toHaveLength(0);
  });

  it('still ingests a small but real buy (above the 0.01 SOL floor)', () => {
    const rows = parseHeliusSwaps([tx(MEME, 'buy')]); // 2 SOL
    expect(rows).toHaveLength(1);
    expect(rows[0].sol_amount).toBeGreaterThan(0.01);
  });
});
