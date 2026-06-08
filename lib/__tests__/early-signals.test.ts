/**
 * EARLY-SIGNALS PHASE 1 — detector unit tests.
 *
 * Covers the three earlier-than-burst signals (live-bursts.detectEarlySignalsForRows
 * + live-feed.annotateFreshLaunch), that classic bursts are unchanged, and the
 * graceful fallback for the live_bursts.type column.
 *
 * detectEarlySignalsForRows / detectBurstsForRows are PURE (no Supabase), so they
 * are tested directly with hand-built BuyRow arrays + a score map.
 */

import {
  detectBurstsForRows,
  detectEarlySignalsForRows,
  type BuyRow,
} from '../indexer/live-bursts';
import { annotateFreshLaunch } from '../indexer/live-feed';
import type { LiveBurst } from '../indexer/live-bursts';

// Scores: tierFromScore → S≥70, A≥50, B≥30, else C.
const S = 80;
const A = 55;

function row(wallet: string, tsMs: number, sol: number, price = 1): BuyRow {
  return { wallet, entity: wallet, ts: tsMs, sol, price };
}

const WINDOW_SEC = 180;

describe('detectEarlySignalsForRows — Detector #1 (first S-tier buy)', () => {
  it('fires early-s1 on a SINGLE S-tier first buy (before 3-wallet convergence)', () => {
    const now = 1_000_000;
    const scores = new Map([['sWallet', S]]);
    const rows = [row('sWallet', now - 5_000, 2 /* SOL ≥ EARLY_S1_MIN_SOL */)];
    const out = detectEarlySignalsForRows('MINT', rows, WINDOW_SEC, scores, now);
    const s1 = out.find((o) => o.type === 'early-s1');
    expect(s1).toBeTruthy();
    expect(s1!.buyers).toBe(1);
    expect(s1!.leadTier).toBe('S');
    expect(s1!.mint).toBe('MINT');
  });

  it('does NOT fire early-s1 when the only buyer is below S tier', () => {
    const now = 1_000_000;
    const scores = new Map([['aWallet', A]]); // A-tier, not S
    const rows = [row('aWallet', now - 5_000, 2)];
    const out = detectEarlySignalsForRows('MINT', rows, WINDOW_SEC, scores, now);
    expect(out.find((o) => o.type === 'early-s1')).toBeUndefined();
  });

  it('respects EARLY_S1_MIN_SOL — a dust S buy does not fire', () => {
    const now = 1_000_000;
    const scores = new Map([['sWallet', S]]);
    const rows = [row('sWallet', now - 5_000, 0.01 /* well below 0.5 default */)];
    const out = detectEarlySignalsForRows('MINT', rows, WINDOW_SEC, scores, now);
    expect(out.find((o) => o.type === 'early-s1')).toBeUndefined();
  });
});

describe('detectEarlySignalsForRows — Detector #3 (heating / velocity spike)', () => {
  it('fires heating when the recent smart-buy rate >> baseline', () => {
    const now = 2_000_000;
    const scores = new Map([
      ['a', A],
      ['b', A],
      ['c', A],
      ['d', A],
    ]);
    // Baseline: one buy long ago (slow), then a CLUSTER of buys inside the recent
    // window → recent rate vastly exceeds the long baseline rate.
    const rows: BuyRow[] = [
      row('a', now - 60 * 60_000, 1), // 1h ago — stretches the baseline span
      row('b', now - 4_000, 1),
      row('c', now - 3_000, 1),
      row('d', now - 2_000, 1),
    ];
    const out = detectEarlySignalsForRows('MINT', rows, WINDOW_SEC, scores, now);
    const heating = out.find((o) => o.type === 'heating');
    expect(heating).toBeTruthy();
    expect(heating!.buyers).toBeGreaterThanOrEqual(3);
  });

  it('does NOT fire heating on a steady, non-accelerating trickle', () => {
    const now = 2_000_000;
    const scores = new Map([['a', A]]);
    // A single recent buy: below HEATING_MIN_BUYS and no spike.
    const rows: BuyRow[] = [row('a', now - 2_000, 1)];
    const out = detectEarlySignalsForRows('MINT', rows, WINDOW_SEC, scores, now);
    expect(out.find((o) => o.type === 'heating')).toBeUndefined();
  });
});

describe('annotateFreshLaunch — Detector #4 (fresh launch age gate)', () => {
  function early(partial: Partial<LiveBurst>): LiveBurst {
    return {
      id: 'id',
      mint: 'MINT',
      type: 'early-s1',
      buyers: 1,
      buyerWallets: 1,
      solTotal: 2,
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      sampleBuyers: ['s'],
      wallets: ['s'],
      side: 'buy',
      tiers: ['S'],
      finalized: false,
      ...partial,
    };
  }

  it('re-tags an EARLY signal to fresh when the token age is under the gate', () => {
    const created = Date.now() - 2 * 60_000; // 2 min old, < 10 min default
    const [b] = annotateFreshLaunch([early({ pairCreatedAt: created })]);
    expect(b.type).toBe('fresh');
  });

  it('leaves an EARLY signal alone when the token is older than the gate', () => {
    const created = Date.now() - 60 * 60_000; // 1h old
    const [b] = annotateFreshLaunch([early({ pairCreatedAt: created })]);
    expect(b.type).toBe('early-s1');
  });

  it('NEVER re-tags a classic burst to fresh, even on a brand-new token', () => {
    const created = Date.now() - 1_000; // 1s old
    const [b] = annotateFreshLaunch([early({ type: 'burst', pairCreatedAt: created })]);
    expect(b.type).toBe('burst');
  });
});

describe('classic burst behavior is unchanged (type: burst, default emission)', () => {
  it('detectBurstsForRows still emits a 3-buyer burst tagged type:burst', () => {
    const now = 1_000_000;
    const scores = new Map([
      ['a', A],
      ['b', A],
      ['c', A],
    ]);
    const rows: BuyRow[] = [
      row('a', now - 6_000, 1),
      row('b', now - 4_000, 1),
      row('c', now - 2_000, 1),
    ];
    const out = detectBurstsForRows('MINT', rows, WINDOW_SEC, 3, scores, now);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('burst');
    expect(out[0].buyers).toBe(3);
  });

  it('detectEarlySignalsForRows fail-closes (empty) when entities are unverified', () => {
    const now = 1_000_000;
    const scores = new Map([['sWallet', S]]);
    const rows = [row('sWallet', now - 5_000, 2)];
    const out = detectEarlySignalsForRows(
      'MINT',
      rows,
      WINDOW_SEC,
      scores,
      now,
      undefined,
      undefined,
      true /* entitiesUnverified */
    );
    expect(out).toHaveLength(0);
  });
});
