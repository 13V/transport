/**
 * GRACEFUL DEGRADATION for the live_bursts.`type` column (migration 0021).
 *
 * The Early-signals outcome tracking adds a `type` column. Until that migration
 * is applied to prod, the persist path must NOT break: persistBursts writes
 * `type` optimistically, and on a Postgres "undefined column" error (42703) it
 * retries WITHOUT `type` (mirroring the seeded/roi_pct pre-migration fallbacks).
 *
 * These tests mock the Supabase client + getLiveBursts so persistBursts runs
 * fully in-memory, and assert the fallback re-upsert succeeds with `type` stripped.
 */

const mockGetLiveBursts = jest.fn();
jest.mock('../indexer/live-bursts', () => ({
  getLiveBursts: (...args: unknown[]) => mockGetLiveBursts(...args),
}));

let upsertCalls: any[][];
let upsertResults: { error: { code?: string; message?: string } | null }[];

const mockFrom = jest.fn();
jest.mock('../supabase-client', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({ from: (...a: unknown[]) => mockFrom(...a) }),
}));

import { persistBursts } from '../indexer/burst-outcomes';

function fakeBurst(id: string, type = 'early-s1') {
  return {
    id,
    mint: 'MINT' + id,
    type,
    side: 'buy',
    symbol: 'SYM',
    windowStart: new Date(1000).toISOString(),
    windowEnd: new Date(2000).toISOString(),
    buyers: 1,
    buyerWallets: 1,
    solTotal: 2,
    sampleBuyers: ['w1'],
    tiers: ['S'],
    allBuyers: ['w1'],
  };
}

beforeEach(() => {
  upsertCalls = [];
  upsertResults = [];
  mockGetLiveBursts.mockReset();
  mockFrom.mockReset();

  // live_bursts.from(...) builder: supports the existing-row read (.select().in())
  // and the .upsert() write. The read returns an empty existing set; the upsert
  // records its rows and returns the next queued result.
  mockFrom.mockImplementation(() => {
    const builder: any = {
      select: () => builder,
      in: () => Promise.resolve({ data: [], error: null }),
      upsert: (rows: any[]) => {
        upsertCalls.push(rows);
        return Promise.resolve(upsertResults.shift() ?? { error: null });
      },
    };
    return builder;
  });
});

describe('persistBursts — type-column graceful fallback', () => {
  it('writes `type` when the column exists (single upsert)', async () => {
    mockGetLiveBursts.mockResolvedValue({ bursts: [fakeBurst('1')] });
    upsertResults = [{ error: null }];

    const res = await persistBursts();
    expect(res.persisted).toBe(1);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0][0]).toHaveProperty('type', 'early-s1');
  });

  it('retries WITHOUT `type` on a 42703 undefined-column error and still persists', async () => {
    mockGetLiveBursts.mockResolvedValue({ bursts: [fakeBurst('1'), fakeBurst('2')] });
    // First upsert fails (column missing), second (stripped) succeeds.
    upsertResults = [
      { error: { code: '42703', message: 'column "type" does not exist' } },
      { error: null },
    ];

    const res = await persistBursts();
    expect(res.persisted).toBe(2);
    expect(upsertCalls).toHaveLength(2);
    // The retry rows must NOT carry `type`.
    expect(upsertCalls[1][0]).not.toHaveProperty('type');
    // ...but must keep the rest of the payload intact.
    expect(upsertCalls[1][0]).toHaveProperty('id', '1');
    expect(upsertCalls[1][0]).toHaveProperty('sol_total', 2);
  });

  it('does NOT retry (and reports 0) on a non-column error', async () => {
    mockGetLiveBursts.mockResolvedValue({ bursts: [fakeBurst('1')] });
    upsertResults = [{ error: { code: '500', message: 'connection reset' } }];

    const res = await persistBursts();
    expect(res.persisted).toBe(0);
    expect(upsertCalls).toHaveLength(1); // no second attempt
  });
});
