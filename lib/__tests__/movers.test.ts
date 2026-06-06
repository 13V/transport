import { computeMovers } from '../indexer/movers';
import type { MoverSnapshotInput } from '../indexer/movers';

describe('computeMovers', () => {
  it('returns [] for empty input', () => {
    expect(computeMovers([])).toEqual([]);
  });

  it('computes rankDelta and roiDelta, sorting bigger climbers first', () => {
    const snapshots: MoverSnapshotInput[] = [
      // climber: rank 50 -> 10, roi 100 -> 140
      { wallet: 'A', day: '2026-06-01', rank: 50, roi_pct: 100 },
      { wallet: 'A', day: '2026-06-05', rank: 10, roi_pct: 140 },
      // small climber: rank 20 -> 18, roi 30 -> 35
      { wallet: 'B', day: '2026-06-01', rank: 20, roi_pct: 30 },
      { wallet: 'B', day: '2026-06-05', rank: 18, roi_pct: 35 },
    ];

    const result = computeMovers(snapshots);

    expect(result.map((m) => m.wallet)).toEqual(['A', 'B']);

    const a = result[0];
    expect(a.rankDelta).toBe(40); // 50 - 10
    expect(a.roiDelta).toBe(40); // 140 - 100
    expect(a.latestRank).toBe(10);
    expect(a.latestRoi).toBe(140);

    const b = result[1];
    expect(b.rankDelta).toBe(2); // 20 - 18
    expect(b.roiDelta).toBe(5); // 35 - 30
  });

  it('uses roiDelta as a tie-break when rankDelta is equal', () => {
    const snapshots: MoverSnapshotInput[] = [
      // both climb 5 ranks; C grows ROI more than D
      { wallet: 'C', day: '2026-06-01', rank: 30, roi_pct: 10 },
      { wallet: 'C', day: '2026-06-05', rank: 25, roi_pct: 60 },
      { wallet: 'D', day: '2026-06-01', rank: 40, roi_pct: 10 },
      { wallet: 'D', day: '2026-06-05', rank: 35, roi_pct: 20 },
    ];

    const result = computeMovers(snapshots);
    expect(result.map((m) => m.wallet)).toEqual(['C', 'D']);
    expect(result[0].rankDelta).toBe(5);
    expect(result[1].rankDelta).toBe(5);
    expect(result[0].roiDelta).toBe(50);
    expect(result[1].roiDelta).toBe(10);
  });

  it('yields null deltas for a single-snapshot wallet and sorts it last', () => {
    const snapshots: MoverSnapshotInput[] = [
      { wallet: 'A', day: '2026-06-01', rank: 50, roi_pct: 100 },
      { wallet: 'A', day: '2026-06-05', rank: 10, roi_pct: 140 },
      { wallet: 'Solo', day: '2026-06-03', rank: 5, roi_pct: 200 },
    ];

    const result = computeMovers(snapshots);

    const solo = result.find((m) => m.wallet === 'Solo')!;
    expect(solo.rankDelta).toBeNull();
    expect(solo.roiDelta).toBeNull();
    // latest values still surfaced for the single snapshot
    expect(solo.latestRank).toBe(5);
    expect(solo.latestRoi).toBe(200);
    // climber with a real delta sorts above the null-delta solo wallet
    expect(result[0].wallet).toBe('A');
    expect(result[result.length - 1].wallet).toBe('Solo');
  });

  it('respects the limit option', () => {
    const snapshots: MoverSnapshotInput[] = [];
    for (let i = 0; i < 10; i++) {
      snapshots.push({ wallet: `W${i}`, day: '2026-06-01', rank: 100 - i, roi_pct: 0 });
      snapshots.push({ wallet: `W${i}`, day: '2026-06-05', rank: 50 - i, roi_pct: 10 });
    }
    expect(computeMovers(snapshots, { limit: 3 })).toHaveLength(3);
  });
});
