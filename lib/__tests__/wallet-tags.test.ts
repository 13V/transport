import { classifyWallet } from '../indexer/wallet-tags';

describe('classifyWallet — tiers', () => {
  it('70 → S', () => {
    expect(classifyWallet({ score: 70 }).tier).toBe('S');
  });
  it('69 → A', () => {
    expect(classifyWallet({ score: 69 }).tier).toBe('A');
  });
  it('50 → A', () => {
    expect(classifyWallet({ score: 50 }).tier).toBe('A');
  });
  it('49 → B', () => {
    expect(classifyWallet({ score: 49 }).tier).toBe('B');
  });
  it('30 → B', () => {
    expect(classifyWallet({ score: 30 }).tier).toBe('B');
  });
  it('29 → C', () => {
    expect(classifyWallet({ score: 29 }).tier).toBe('C');
  });
  it('missing score → C', () => {
    expect(classifyWallet({}).tier).toBe('C');
  });
});

describe('classifyWallet — tags fire on representative inputs', () => {
  it('high-roi fires at >=25 and not below', () => {
    expect(classifyWallet({ roiPct: 25 }).tags).toContain('high-roi');
    expect(classifyWallet({ roiPct: 24 }).tags).not.toContain('high-roi');
    expect(classifyWallet({ roiPct: null }).tags).not.toContain('high-roi');
  });

  it('whale fires at >=50 invested and not below', () => {
    expect(classifyWallet({ investedSol: 50 }).tags).toContain('whale');
    expect(classifyWallet({ investedSol: 49 }).tags).not.toContain('whale');
    expect(classifyWallet({ investedSol: null }).tags).not.toContain('whale');
  });

  it('consistent fires at >=0.6 and not below', () => {
    expect(classifyWallet({ consistency: 0.6 }).tags).toContain('consistent');
    expect(classifyWallet({ consistency: 0.59 }).tags).not.toContain('consistent');
  });

  it('high-winrate fires at >=0.6 and not below', () => {
    expect(classifyWallet({ winRate: 0.6 }).tags).toContain('high-winrate');
    expect(classifyWallet({ winRate: 0.59 }).tags).not.toContain('high-winrate');
  });

  it('active fires at >=100 trades and not below', () => {
    expect(classifyWallet({ totalTrades: 100 }).tags).toContain('active');
    expect(classifyWallet({ totalTrades: 99 }).tags).not.toContain('active');
  });

  it('diversified fires at >=30 tokens and not below', () => {
    expect(classifyWallet({ tokensTraded: 30 }).tags).toContain('diversified');
    expect(classifyWallet({ tokensTraded: 29 }).tags).not.toContain('diversified');
  });
});

describe('classifyWallet — sharpshooter', () => {
  it('low win rate but profitable → sharpshooter', () => {
    const c = classifyWallet({ winRate: 0.3, roiPct: 120 });
    expect(c.tags).toContain('sharpshooter');
    expect(c.tags).not.toContain('high-winrate');
  });

  it('low win rate but not profitable → no sharpshooter', () => {
    expect(classifyWallet({ winRate: 0.3, roiPct: 0 }).tags).not.toContain('sharpshooter');
    expect(classifyWallet({ winRate: 0.3, roiPct: -10 }).tags).not.toContain('sharpshooter');
    expect(classifyWallet({ winRate: 0.3, roiPct: null }).tags).not.toContain('sharpshooter');
  });

  it('win rate at/above 0.4 → no sharpshooter even if profitable', () => {
    expect(classifyWallet({ winRate: 0.4, roiPct: 120 }).tags).not.toContain('sharpshooter');
  });
});

describe('classifyWallet — combined', () => {
  it('an elite whale earns tier S and multiple tags', () => {
    const c = classifyWallet({
      score: 88,
      roiPct: 300,
      investedSol: 200,
      consistency: 0.8,
      winRate: 0.7,
      totalTrades: 500,
      tokensTraded: 60,
    });
    expect(c.tier).toBe('S');
    expect(c.tags).toEqual(
      expect.arrayContaining(['high-roi', 'whale', 'consistent', 'high-winrate', 'active', 'diversified'])
    );
    expect(c.tags).not.toContain('sharpshooter');
  });

  it('empty input → tier C, no tags', () => {
    expect(classifyWallet({})).toEqual({ tier: 'C', tags: [] });
  });
});
