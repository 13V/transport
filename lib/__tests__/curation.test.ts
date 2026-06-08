import { isSmartWallet, getSmartCriteria } from '../indexer/curation';
import type { CuratableStat, SmartCriteria } from '../indexer/curation';

const NOW = new Date('2026-06-05T00:00:00Z').getTime();

// Default criteria matching getSmartCriteria() defaults (no env overrides).
// These mirror the tightened defaults in lib/indexer/curation.ts.
const baseCriteria: SmartCriteria = {
  minRoiPct: 30,
  minPnlSol: 2,
  minInvestedSol: 5,
  minTrades: 30,
  minTokens: 10,
  maxWinRate: 1,
  minConsistency: 0,
  minProfitFactor: 0,
  suspectWinRate: 0.95,
  suspectMinEvents: 30,
  maxIdleDays: 90,
};

// A stat that comfortably clears every default bar.
function goodStat(overrides: Partial<CuratableStat> = {}): CuratableStat {
  return {
    realizedPnl: 50,
    roiPct: 120,
    investedSol: 40,
    winRate: 0.4,
    totalTrades: 40,
    tokensTraded: 15,
    lastTradeAt: new Date(NOW - 2 * 86_400_000), // 2 days ago
    seeded: false,
    ...overrides,
  };
}

describe('isSmartWallet', () => {
  it('verified profitable wallet passes', () => {
    expect(isSmartWallet(goodStat(), baseCriteria, NOW)).toBe(true);
  });

  it('roiPct null (not deep-scanned) → rejected', () => {
    expect(isSmartWallet(goodStat({ roiPct: null }), baseCriteria, NOW)).toBe(false);
    expect(isSmartWallet(goodStat({ roiPct: undefined }), baseCriteria, NOW)).toBe(false);
  });

  it('below minRoiPct → rejected', () => {
    // ROI present but negative, with minRoiPct floor at 0.
    expect(isSmartWallet(goodStat({ roiPct: -5 }), baseCriteria, NOW)).toBe(false);
  });

  it('below minPnlSol → rejected', () => {
    expect(isSmartWallet(goodStat({ realizedPnl: 0.5 }), baseCriteria, NOW)).toBe(false);
  });

  it('minInvestedSol respected when set', () => {
    const criteria: SmartCriteria = { ...baseCriteria, minInvestedSol: 100 };
    // invested 40 < 100 → rejected
    expect(isSmartWallet(goodStat({ investedSol: 40 }), criteria, NOW)).toBe(false);
    // invested 150 >= 100 → passes
    expect(isSmartWallet(goodStat({ investedSol: 150 }), criteria, NOW)).toBe(true);
    // when off (0), low invested is irrelevant
    const off: SmartCriteria = { ...baseCriteria, minInvestedSol: 0 };
    expect(isSmartWallet(goodStat({ investedSol: 0 }), off, NOW)).toBe(true);
  });

  it('seeded wallet always passes, regardless of other failing fields', () => {
    const failing: CuratableStat = {
      realizedPnl: -100,
      roiPct: null,
      investedSol: 0,
      winRate: 0,
      totalTrades: 0,
      tokensTraded: 0,
      lastTradeAt: new Date(NOW - 1000 * 86_400_000), // ancient
      seeded: true,
    };
    expect(isSmartWallet(failing, baseCriteria, NOW)).toBe(true);
  });

  it('idle wallet (old lastTradeAt beyond maxIdleDays) → rejected', () => {
    const idle = goodStat({ lastTradeAt: new Date(NOW - 100 * 86_400_000) }); // 100 > 90
    expect(isSmartWallet(idle, baseCriteria, NOW)).toBe(false);
    // just inside the window passes
    const fresh = goodStat({ lastTradeAt: new Date(NOW - 89 * 86_400_000) });
    expect(isSmartWallet(fresh, baseCriteria, NOW)).toBe(true);
  });

  it('below minTrades or minTokens → rejected', () => {
    expect(isSmartWallet(goodStat({ totalTrades: 5 }), baseCriteria, NOW)).toBe(false);
    expect(isSmartWallet(goodStat({ tokensTraded: 2 }), baseCriteria, NOW)).toBe(false);
  });

  it('getSmartCriteria returns documented defaults when no env overrides set', () => {
    const saved = { ...process.env };
    for (const k of [
      'SMART_MIN_ROI_PCT',
      'SMART_MIN_PNL_SOL',
      'SMART_MIN_INVESTED_SOL',
      'SMART_MIN_TRADES',
      'SMART_MIN_TOKENS',
      'SMART_MAX_WIN_RATE',
      'SMART_MIN_CONSISTENCY',
      'SMART_MIN_PROFIT_FACTOR',
      'SMART_SUSPECT_WIN_RATE',
      'SMART_SUSPECT_MIN_EVENTS',
      'SMART_MAX_IDLE_DAYS',
    ]) {
      delete process.env[k];
    }
    const c = getSmartCriteria();
    expect(c).toEqual(baseCriteria);
    process.env = saved;
  });
});
