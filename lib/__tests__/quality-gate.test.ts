/**
 * ALERT QUALITY GATE (lib/alerts/quality-gate) — suppression semantics.
 *
 * The gate suppresses when ANY of: a PROVEN-loser signal type (measured n >=
 * ALERT_TYPE_MIN_N with hitRate1h < ALERT_TYPE_MIN_HIT), weak conviction (zero
 * S-tier buyers AND buyers < ALERT_MIN_BUYERS), or bundleFlag === true. Two
 * properties matter more than the suppressions themselves and get explicit
 * coverage: the gate FAILS OPEN on any internal error (an alerting outage is
 * worse than noise), and the ALERT_QUALITY_GATE='0' kill-switch bypasses it.
 *
 * getBurstStats is mocked so no Supabase/network is touched; the module-level
 * stats cache is reset per test via the exported test hook.
 */

const mockGetBurstStats = jest.fn();
jest.mock('../indexer/burst-outcomes', () => ({
  getBurstStats: (...args: unknown[]) => mockGetBurstStats(...args),
}));

import { shouldAlert, __resetQualityGateCache } from '../alerts/quality-gate';

/** Minimal BurstStats shape with the given per-type 1h breakdown. */
function stats(byType: Record<string, { n: number; medianRet1h: number | null; hitRate1h: number | null }>) {
  return {
    n: 100,
    burstsToday: 10,
    medianRet1h: 1,
    hitRate1h: 50,
    medianRet24h: null,
    hitRate24h: null,
    bestCall: null,
    windowHours: 72,
    byType,
  };
}

/** A burst that passes every non-type check (S-tier present, enough buyers). */
function strongBurst(type: string) {
  return { type, tiers: ['S', 'A'], buyers: 5, bundleFlag: false };
}

const GATE_ENVS = [
  'ALERT_QUALITY_GATE',
  'ALERT_TYPE_MIN_N',
  'ALERT_TYPE_MIN_HIT',
  'ALERT_MIN_BUYERS',
];

beforeEach(() => {
  mockGetBurstStats.mockReset();
  __resetQualityGateCache();
  for (const k of GATE_ENVS) delete process.env[k];
});

afterAll(() => {
  for (const k of GATE_ENVS) delete process.env[k];
});

describe('shouldAlert — proven-loser type', () => {
  it('suppresses a type with n >= 30 and hitRate1h < 25', async () => {
    mockGetBurstStats.mockResolvedValue(
      stats({ heating: { n: 40, medianRet1h: -8, hitRate1h: 12 } })
    );
    const res = await shouldAlert(strongBurst('heating'));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/heating/);
    expect(res.reason).toMatch(/proven loser/);
  });

  it('passes an UNMEASURED type (no byType entry) — only proven losers are silenced', async () => {
    mockGetBurstStats.mockResolvedValue(stats({}));
    const res = await shouldAlert(strongBurst('early-s1'));
    expect(res).toEqual({ ok: true });
  });

  it('passes a losing type with too few samples (n < ALERT_TYPE_MIN_N)', async () => {
    mockGetBurstStats.mockResolvedValue(
      stats({ fresh: { n: 10, medianRet1h: -20, hitRate1h: 5 } })
    );
    const res = await shouldAlert(strongBurst('fresh'));
    expect(res).toEqual({ ok: true });
  });

  it('passes a well-measured WINNING type', async () => {
    mockGetBurstStats.mockResolvedValue(
      stats({ burst: { n: 200, medianRet1h: 9, hitRate1h: 48 } })
    );
    const res = await shouldAlert(strongBurst('burst'));
    expect(res).toEqual({ ok: true });
  });

  it("defaults a missing type to 'burst' (matching live_bursts persistence)", async () => {
    mockGetBurstStats.mockResolvedValue(
      stats({ burst: { n: 50, medianRet1h: -5, hitRate1h: 10 } })
    );
    const res = await shouldAlert({ tiers: ['S'], buyers: 4 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/"burst"/);
  });

  it('honors ALERT_TYPE_MIN_N / ALERT_TYPE_MIN_HIT overrides', async () => {
    mockGetBurstStats.mockResolvedValue(
      stats({ heating: { n: 12, medianRet1h: 0, hitRate1h: 30 } })
    );
    // Defaults would pass (n < 30 and 30% >= 25%); tightened thresholds suppress.
    process.env.ALERT_TYPE_MIN_N = '10';
    process.env.ALERT_TYPE_MIN_HIT = '35';
    const res = await shouldAlert(strongBurst('heating'));
    expect(res.ok).toBe(false);
  });
});

describe('shouldAlert — weak conviction (no S-tier + few buyers)', () => {
  it('suppresses zero S-tier entries with buyers < 3', async () => {
    mockGetBurstStats.mockResolvedValue(stats({}));
    const res = await shouldAlert({ type: 'burst', tiers: ['A', 'B'], buyers: 2 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no S-tier/);
  });

  it('passes when an S-tier buyer is present even with few buyers', async () => {
    mockGetBurstStats.mockResolvedValue(stats({}));
    const res = await shouldAlert({ type: 'burst', tiers: ['S'], buyers: 1 });
    expect(res).toEqual({ ok: true });
  });

  it('passes no-S bursts once buyers reach ALERT_MIN_BUYERS', async () => {
    mockGetBurstStats.mockResolvedValue(stats({}));
    const res = await shouldAlert({ type: 'burst', tiers: ['A', 'B', null], buyers: 3 });
    expect(res).toEqual({ ok: true });
  });

  it('treats missing tiers/buyers as zero conviction (suppressed)', async () => {
    mockGetBurstStats.mockResolvedValue(stats({}));
    const res = await shouldAlert({ type: 'burst' });
    expect(res.ok).toBe(false);
  });
});

describe('shouldAlert — bundle risk', () => {
  it('suppresses bundleFlag === true', async () => {
    mockGetBurstStats.mockResolvedValue(stats({}));
    const res = await shouldAlert({ ...strongBurst('burst'), bundleFlag: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/bundled/);
  });

  it('passes unchecked bundleFlag (undefined/null) — only an explicit true suppresses', async () => {
    mockGetBurstStats.mockResolvedValue(stats({}));
    expect((await shouldAlert({ type: 'burst', tiers: ['S'], buyers: 4 })).ok).toBe(true);
    expect(
      (await shouldAlert({ type: 'burst', tiers: ['S'], buyers: 4, bundleFlag: null })).ok
    ).toBe(true);
  });
});

describe('shouldAlert — fail open + kill-switch', () => {
  it('FAILS OPEN when the stats read throws (alerting outage > noise)', async () => {
    mockGetBurstStats.mockRejectedValue(new Error('supabase exploded'));
    const res = await shouldAlert(strongBurst('burst'));
    expect(res).toEqual({ ok: true });
  });

  it('ALERT_QUALITY_GATE=0 bypasses every check (even a flagged bundle of a proven loser)', async () => {
    process.env.ALERT_QUALITY_GATE = '0';
    mockGetBurstStats.mockResolvedValue(
      stats({ burst: { n: 100, medianRet1h: -50, hitRate1h: 1 } })
    );
    const res = await shouldAlert({ type: 'burst', tiers: [], buyers: 0, bundleFlag: true });
    expect(res).toEqual({ ok: true });
    // The bypass short-circuits before the stats read.
    expect(mockGetBurstStats).not.toHaveBeenCalled();
  });
});

describe('shouldAlert — stats caching', () => {
  it('reads getBurstStats(72) once and serves repeat calls from the 10-min cache', async () => {
    mockGetBurstStats.mockResolvedValue(stats({}));
    await shouldAlert(strongBurst('burst'));
    await shouldAlert(strongBurst('heating'));
    await shouldAlert(strongBurst('fresh'));
    expect(mockGetBurstStats).toHaveBeenCalledTimes(1);
    expect(mockGetBurstStats).toHaveBeenCalledWith(72);
  });
});
