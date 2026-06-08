import {
  isSmartWallet,
  getSmartCriteria,
  getBroadSmartCriteria,
  isSmartBroad,
  smartTier,
} from '../indexer/curation';
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

describe('broad smart tier (SMART2_* / getBroadSmartCriteria / smartTier / isSmartBroad)', () => {
  // Env keys that influence either tier — cleared around each test so defaults apply.
  const TIER_ENV = [
    'SMART_TIERS_ENABLED',
    'SMART2_MIN_ROI_PCT',
    'SMART2_MIN_PNL_SOL',
    'SMART2_MIN_INVESTED_SOL',
    'SMART2_MIN_TRADES',
    'SMART2_MIN_TOKENS',
    'SMART_MIN_ROI_PCT',
    'SMART_MIN_PNL_SOL',
    'SMART_MIN_INVESTED_SOL',
    'SMART_MIN_TRADES',
    'SMART_MIN_TOKENS',
    'SMART_SUSPECT_WIN_RATE',
    'SMART_SUSPECT_MIN_EVENTS',
    'SMART_ALLOW_BOTS',
  ];
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    for (const k of TIER_ENV) delete process.env[k];
  });
  afterEach(() => {
    process.env = saved;
  });

  it('getBroadSmartCriteria has the documented looser size defaults + identical safety gates', () => {
    const broad = getBroadSmartCriteria();
    const strict = getSmartCriteria();
    // Looser size/edge thresholds.
    expect(broad.minRoiPct).toBe(15);
    expect(broad.minPnlSol).toBe(0.5);
    expect(broad.minInvestedSol).toBe(2);
    expect(broad.minTrades).toBe(15);
    expect(broad.minTokens).toBe(8);
    // IDENTICAL anti-bot / anti-fraud gates.
    expect(broad.suspectWinRate).toBe(strict.suspectWinRate);
    expect(broad.suspectMinEvents).toBe(strict.suspectMinEvents);
    expect(broad.maxIdleDays).toBe(strict.maxIdleDays);
    expect(broad.minConsistency).toBe(strict.minConsistency);
    expect(broad.minProfitFactor).toBe(strict.minProfitFactor);
    expect(broad.maxWinRate).toBe(strict.maxWinRate);
  });

  it('kill-switch SMART_TIERS_ENABLED=0 makes broad == strict (single-tier rollback)', () => {
    process.env.SMART_TIERS_ENABLED = '0';
    expect(getBroadSmartCriteria()).toEqual(getSmartCriteria());
    // With broad==strict, an A-only wallet no longer qualifies.
    const aOnly = goodStat({ roiPct: 20, realizedPnl: 1, investedSol: 3, totalTrades: 20, tokensTraded: 8 });
    expect(isSmartBroad(aOnly, NOW)).toBe(false);
    expect(smartTier(aOnly, NOW)).toBeNull();
  });

  it('smartTier: elite wallet is S', () => {
    expect(smartTier(goodStat(), NOW)).toBe('S');
    expect(isSmartBroad(goodStat(), NOW)).toBe(true);
  });

  it('smartTier: broad-but-not-elite wallet is A (passes broad, fails strict)', () => {
    // ROI 20 (<30 strict, >=15 broad), PnL 1 (<2 strict, >=0.5 broad),
    // invested 3 (<5 strict, >=2 broad), 20 trades (<30 strict, >=15 broad),
    // 8 tokens (<10 strict, >=8 broad).
    const a = goodStat({ roiPct: 20, realizedPnl: 1, investedSol: 3, totalTrades: 20, tokensTraded: 8 });
    expect(isSmartWallet(a, getSmartCriteria(), NOW)).toBe(false); // fails strict
    expect(isSmartBroad(a, NOW)).toBe(true); // passes broad
    expect(smartTier(a, NOW)).toBe('A');
  });

  it('smartTier: wallet below even the broad floor is null', () => {
    const tooLow = goodStat({ roiPct: 5, realizedPnl: 0.1, investedSol: 1, totalTrades: 5, tokensTraded: 2 });
    expect(isSmartBroad(tooLow, NOW)).toBe(false);
    expect(smartTier(tooLow, NOW)).toBeNull();
  });

  it('broad tier STILL rejects suspect win-rate (≥0.95 over a large sample)', () => {
    // Clears every broad size floor but has a suspiciously perfect win rate over
    // a large realized sample — the broad tier keeps the SAME suspect gate.
    const suspect = goodStat({
      roiPct: 20,
      realizedPnl: 1,
      investedSol: 3,
      totalTrades: 40,
      tokensTraded: 8,
      winRate: 0.98,
      realizedEvents: 40,
    });
    expect(isSmartBroad(suspect, NOW)).toBe(false);
    expect(smartTier(suspect, NOW)).toBeNull();
  });

  it('broad tier STILL rejects likely bots', () => {
    // High trade count, tiny tokens-traded, near-zero avg trade size → bot-like.
    // This pattern is rejected by detectBot regardless of tier.
    const bot = goodStat({
      roiPct: 20,
      realizedPnl: 1,
      investedSol: 0.01,
      totalTrades: 5000,
      tokensTraded: 8,
      winRate: 0.5,
    });
    expect(isSmartBroad(bot, NOW)).toBe(false);
  });
});
