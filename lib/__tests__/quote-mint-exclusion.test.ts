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
