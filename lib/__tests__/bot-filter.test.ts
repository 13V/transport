import { detectBot } from '../indexer/bot-filter';
import type { BotSignal } from '../indexer/bot-filter';

describe('detectBot', () => {
  it('does not flag a normal discretionary trader', () => {
    const r: BotSignal = detectBot({
      totalTrades: 60,
      tokensTraded: 25,
      realizedPnl: 40,
      investedSol: 200,
      roiPct: 20,
      winRate: 0.5,
      avgTradeSol: 3.3,
    });
    expect(r.isLikelyBot).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('flags a hyperactive churner (high volume, few tokens)', () => {
    // 800 trades over 5 tokens = 160 trades/token, well past the 30 floor.
    const r = detectBot({
      totalTrades: 800,
      tokensTraded: 5,
      realizedPnl: 10,
      roiPct: 8,
      winRate: 0.6,
      avgTradeSol: 2,
    });
    expect(r.isLikelyBot).toBe(true);
    expect(r.reasons).toContain('hyperactive');
  });

  it('flags a dust-size MEV wallet', () => {
    const r = detectBot({
      totalTrades: 120,
      tokensTraded: 40,
      realizedPnl: 0.2,
      roiPct: 4,
      winRate: 0.55,
      avgTradeSol: 0.004,
    });
    expect(r.isLikelyBot).toBe(true);
    expect(r.reasons).toContain('dust-size');
  });

  it('flags a high-volume zero-edge arb/MEV wallet', () => {
    const r = detectBot({
      totalTrades: 5000,
      tokensTraded: 300,
      realizedPnl: 2,
      roiPct: 0.3,
      winRate: 0.6,
      avgTradeSol: 1.5,
    });
    expect(r.isLikelyBot).toBe(true);
    expect(r.reasons).toContain('near-zero-edge-highvol');
  });

  it('flags an extreme win-rate wallet at scale', () => {
    const r = detectBot({
      totalTrades: 400,
      tokensTraded: 50,
      realizedPnl: 30,
      roiPct: 15,
      winRate: 0.99,
      avgTradeSol: 2,
    });
    expect(r.isLikelyBot).toBe(true);
    expect(r.reasons).toContain('extreme-winrate-highvol');
  });

  it('is conservative: high win rate on a small sample is NOT flagged', () => {
    const r = detectBot({
      totalTrades: 30,
      tokensTraded: 10,
      roiPct: 50,
      winRate: 1,
      avgTradeSol: 2,
    });
    expect(r.isLikelyBot).toBe(false);
  });

  it('handles missing/partial fields without throwing', () => {
    const r = detectBot({});
    expect(r.isLikelyBot).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('does not treat zero/negative avgTradeSol as dust', () => {
    const r = detectBot({ totalTrades: 10, tokensTraded: 5, avgTradeSol: 0 });
    expect(r.reasons).not.toContain('dust-size');
  });
});
