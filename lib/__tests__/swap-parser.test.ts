import { parseTradeFromTx, parseWalletTradesFromTx } from '../indexer/swap-fetcher';

const LAMPORTS_PER_SOL = 1_000_000_000;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const WALLET = 'TraderWalletAddress1111111111111111111111111';
const MINT = 'TargetMint11111111111111111111111111111111111';
const MINT2 = 'OtherMint222222222222222222222222222222222222';

// Build a token balance change entry for an account.
function tbc(userAccount: string, mint: string, uiAmount: number, decimals = 6) {
  return {
    userAccount,
    mint,
    rawTokenAmount: {
      tokenAmount: String(Math.round(uiAmount * Math.pow(10, decimals))),
      decimals,
    },
  };
}

describe('parseTradeFromTx', () => {
  it('clean SOL BUY: fee payer gains mint, loses native SOL → BUY with right amount/price', () => {
    // Pays 2 SOL native, fee 0.0005 SOL, receives 1000 tokens.
    const fee = 0.0005 * LAMPORTS_PER_SOL;
    const tx = {
      feePayer: WALLET,
      fee,
      signature: 'sigBuy',
      timestamp: 1_700_000_000,
      source: 'RAYDIUM',
      accountData: [
        {
          account: WALLET,
          // native change includes the fee (it's deducted from the wallet).
          nativeBalanceChange: -2 * LAMPORTS_PER_SOL - fee,
          tokenBalanceChanges: [tbc(WALLET, MINT, 1000)],
        },
      ],
    };

    const wt = parseTradeFromTx(tx, MINT);
    expect(wt).not.toBeNull();
    expect(wt!.wallet).toBe(WALLET);
    expect(wt!.trade.tradeType).toBe('BUY');
    expect(wt!.trade.amount).toBe(1000);
    // fee added back → SOL paid is exactly 2, price = 2/1000.
    expect(wt!.trade.pricePerToken).toBeCloseTo(2 / 1000, 12);
    expect(wt!.trade.tokenMint).toBe(MINT);
    expect(wt!.trade.source).toBe('RAYDIUM');
  });

  it('clean SOL SELL: fee payer loses mint, gains native SOL → SELL', () => {
    // Sells 500 tokens, receives 3 SOL net (after fee already netted out by Helius);
    // fee 0.0005 SOL is added back so received = 3 + 0.0005.
    const fee = 0.0005 * LAMPORTS_PER_SOL;
    const tx = {
      feePayer: WALLET,
      fee,
      signature: 'sigSell',
      timestamp: 1_700_000_100,
      source: 'JUPITER',
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: 3 * LAMPORTS_PER_SOL - fee,
          tokenBalanceChanges: [tbc(WALLET, MINT, -500)],
        },
      ],
    };

    const wt = parseTradeFromTx(tx, MINT);
    expect(wt).not.toBeNull();
    expect(wt!.trade.tradeType).toBe('SELL');
    expect(wt!.trade.amount).toBe(500);
    expect(wt!.trade.pricePerToken).toBeCloseTo(3 / 500, 12);
  });

  it('adds tx.fee back: price differs with vs without the fee correction', () => {
    const fee = 0.05 * LAMPORTS_PER_SOL; // a large fee to make the gap obvious
    const base = {
      feePayer: WALLET,
      signature: 'sigFee',
      timestamp: 1_700_000_000,
      source: 'RAYDIUM',
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: -1 * LAMPORTS_PER_SOL - fee,
          tokenBalanceChanges: [tbc(WALLET, MINT, 100)],
        },
      ],
    };

    const withFee = parseTradeFromTx({ ...base, fee }, MINT);
    const withoutFee = parseTradeFromTx({ ...base, fee: 0 }, MINT);

    // With fee added back, SOL paid = 1.0 → price 0.01.
    expect(withFee!.trade.pricePerToken).toBeCloseTo(1 / 100, 12);
    // Without the correction, SOL paid = 1.05 → price 0.0105.
    expect(withoutFee!.trade.pricePerToken).toBeCloseTo(1.05 / 100, 12);
    expect(withFee!.trade.pricePerToken).toBeLessThan(withoutFee!.trade.pricePerToken);
  });

  it('USDC-quoted swap (no native/WSOL move) → null', () => {
    // Wallet swaps USDC for the target mint: gains MINT, loses USDC, no SOL.
    const tx = {
      feePayer: WALLET,
      fee: 0, // no native change at all
      signature: 'sigUsdc',
      timestamp: 1_700_000_000,
      source: 'JUPITER',
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            tbc(WALLET, MINT, 1000),
            tbc(WALLET, USDC_MINT, -250),
          ],
        },
      ],
    };

    expect(parseTradeFromTx(tx, MINT)).toBeNull();
  });

  it('returns null when fee payer is not the taker of the mint', () => {
    const tx = {
      feePayer: WALLET,
      fee: 0,
      signature: 'sigNone',
      timestamp: 1_700_000_000,
      source: 'RAYDIUM',
      accountData: [
        { account: WALLET, nativeBalanceChange: -1 * LAMPORTS_PER_SOL, tokenBalanceChanges: [] },
      ],
    };
    expect(parseTradeFromTx(tx, MINT)).toBeNull();
  });
});

describe('parseWalletTradesFromTx', () => {
  it('single-mint swap → one trade', () => {
    const tx = {
      feePayer: WALLET,
      fee: 0,
      signature: 'sigSingle',
      timestamp: 1_700_000_000,
      source: 'RAYDIUM',
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: -2 * LAMPORTS_PER_SOL,
          tokenBalanceChanges: [tbc(WALLET, MINT, 1000)],
        },
      ],
    };

    const trades = parseWalletTradesFromTx(tx, WALLET);
    expect(trades).toHaveLength(1);
    expect(trades[0].tradeType).toBe('BUY');
    expect(trades[0].tokenMint).toBe(MINT);
    expect(trades[0].amount).toBe(1000);
    expect(trades[0].pricePerToken).toBeCloseTo(2 / 1000, 12);
  });

  it('multi-mint (token-to-token) swap → [] (can\'t be SOL-priced)', () => {
    // Wallet moves two non-WSOL mints → not a clean single-mint-vs-SOL swap.
    const tx = {
      feePayer: WALLET,
      fee: 0,
      signature: 'sigMulti',
      timestamp: 1_700_000_000,
      source: 'JUPITER',
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            tbc(WALLET, MINT, 1000),
            tbc(WALLET, MINT2, -500),
          ],
        },
      ],
    };

    expect(parseWalletTradesFromTx(tx, WALLET)).toEqual([]);
  });

  it('WSOL counts as SOL, not as a separate mint (single-mint-vs-WSOL → one trade)', () => {
    // Wallet gains MINT, loses WSOL. WSOL is folded into solDelta, so mintDeltas
    // has exactly one entry and the swap is priced in SOL.
    const tx = {
      feePayer: WALLET,
      fee: 0,
      signature: 'sigWsol',
      timestamp: 1_700_000_000,
      source: 'ORCA',
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            tbc(WALLET, MINT, 1000),
            tbc(WALLET, WSOL_MINT, -2, 9),
          ],
        },
      ],
    };

    const trades = parseWalletTradesFromTx(tx, WALLET);
    expect(trades).toHaveLength(1);
    expect(trades[0].tradeType).toBe('BUY');
    expect(trades[0].pricePerToken).toBeCloseTo(2 / 1000, 12);
  });
});
