/**
 * SMART-SET PERSISTED SNAPSHOT CACHE
 *
 * The smart-wallet set (verified wallets clearing the curation gate + their
 * funding-cluster entity map + scores + conviction stats) is EXPENSIVE to
 * resolve: it paginates the verified-wallet gate and runs many wallet_links
 * cluster queries (see resolveSmartSet in ./live-bursts). It changes slowly
 * (cron cadence), yet under serverless load — many instances, frequent cold
 * starts, plus the live feed, the Helius webhook on every trade, and
 * persist-bursts all calling it — that heavy resolve runs constantly and is a
 * top source of Supabase DB-compute load on the free tier.
 *
 * This module adds a SECOND cache layer behind the in-process memo: a single
 * compact JSON snapshot row in the existing `indexer_state` kv table (same
 * read/write-blob pattern as lib/alerts/cooldowns.ts). On an in-process miss a
 * caller does one cheap single-row READ instead of the full resolve; only when
 * the snapshot is missing or stale does ONE caller (globally, per ~5 min) run
 * the heavy resolve and write a fresh snapshot.
 *
 * Resilient by design: any read/write/parse failure returns null (read) or
 * no-ops (write), so callers always fall back to the live resolveSmartSet path
 * and nothing breaks. The reconstructed SmartSet is the SAME shape/contract the
 * live resolver returns (wallets, walletToEntity, scoreByWallet, statsByWallet),
 * so all callers keep working unchanged.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import type { SmartSet } from './live-bursts';

/** indexer_state key holding the compact smart-set snapshot blob. */
const SNAPSHOT_KEY = 'smart_set_snapshot';

/**
 * How long a persisted snapshot is considered fresh. The smart set only moves
 * on cron cadence, so ~5 min means the heavy resolve runs at most about once per
 * 5 min GLOBALLY (whichever instance misses), not per cold instance.
 */
export const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/**
 * COMPACT on-disk shape. Maps are stored as parallel/positional arrays to keep
 * egress lean on the free tier:
 *  - w : wallet addresses (string[])  — the SmartSet.wallets set
 *  - e : [wallet, entityId] pairs     — only wallets that belong to a cluster
 *  - s : [wallet, score] pairs        — SmartSet.scoreByWallet
 *  - st: [wallet, roiPct, winRate, realizedPnl] tuples — SmartSet.statsByWallet.
 *        `score` is intentionally NOT duplicated here; it is re-attached from
 *        `s` (scoreByWallet) on read, since stats.score === scoreByWallet value.
 *  - fb: [inheritedWallet, funderWallet] pairs — SmartSet.fundedByWallet (smart
 *        inheritance: a fresh wallet -> the verified smart wallet that funded it).
 *        OPTIONAL: older blobs written before this field are tolerated (absent ->
 *        empty map), so no inheritance badges render until the next snapshot.
 * `at` is the write epoch-ms used for the TTL freshness check.
 */
interface SnapshotBlob {
  at: number;
  w: string[];
  e: [string, string][];
  s: [string, number][];
  st: [string, number | null, number | null, number][];
  fb?: [string, string][];
}

/**
 * Read the persisted snapshot and rebuild a SmartSet. Returns null when:
 * Supabase is unconfigured, the row is absent, the blob is stale (older than
 * SNAPSHOT_TTL_MS), it parses to an empty set, or anything throws. A null
 * result tells the caller to fall back to the live resolve path.
 */
export async function readSnapshot(): Promise<SmartSet | null> {
  if (!isSupabaseConfigured()) return null;

  try {
    const supabase = getSupabase();
    const { data: stateRow, error } = await supabase
      .from('indexer_state')
      .select('value')
      .eq('key', SNAPSHOT_KEY)
      .maybeSingle();
    if (error) return null;

    const blob = stateRow?.value as Partial<SnapshotBlob> | null | undefined;
    if (!blob || typeof blob !== 'object') return null;

    const at = Number(blob.at);
    if (!Number.isFinite(at) || Date.now() - at >= SNAPSHOT_TTL_MS) return null;

    const walletsArr = Array.isArray(blob.w) ? blob.w : [];
    if (walletsArr.length === 0) return null; // empty/garbage -> resolve live

    const wallets = new Set<string>();
    for (const w of walletsArr) {
      if (typeof w === 'string' && w) wallets.add(w);
    }
    if (wallets.size === 0) return null;

    const walletToEntity = new Map<string, string>();
    for (const pair of Array.isArray(blob.e) ? blob.e : []) {
      const [w, ent] = pair as [string, string];
      if (typeof w === 'string' && typeof ent === 'string') walletToEntity.set(w, ent);
    }

    const scoreByWallet = new Map<string, number>();
    for (const pair of Array.isArray(blob.s) ? blob.s : []) {
      const [w, score] = pair as [string, number];
      const n = Number(score);
      if (typeof w === 'string' && Number.isFinite(n)) scoreByWallet.set(w, n);
    }

    const statsByWallet = new Map<
      string,
      { score: number; roiPct: number | null; winRate: number | null; realizedPnl: number }
    >();
    for (const tuple of Array.isArray(blob.st) ? blob.st : []) {
      const [w, roiPct, winRate, realizedPnl] = tuple as [
        string,
        number | null,
        number | null,
        number
      ];
      if (typeof w !== 'string' || !w) continue;
      const score = scoreByWallet.get(w) ?? 0; // score lives in scoreByWallet
      const roi = roiPct == null ? null : Number(roiPct);
      const wr = winRate == null ? null : Number(winRate);
      const pnl = Number(realizedPnl);
      statsByWallet.set(w, {
        score,
        roiPct: roi != null && Number.isFinite(roi) ? roi : null,
        winRate: wr != null && Number.isFinite(wr) ? wr : null,
        realizedPnl: Number.isFinite(pnl) ? pnl : 0,
      });
    }

    // SMART INHERITANCE map (inherited wallet -> funder). Tolerate older blobs
    // that predate this field: absent `fb` simply yields an empty map (no badges).
    const fundedByWallet = new Map<string, string>();
    for (const pair of Array.isArray(blob.fb) ? blob.fb : []) {
      const [w, funder] = pair as [string, string];
      if (typeof w === 'string' && w && typeof funder === 'string' && funder) {
        fundedByWallet.set(w, funder);
      }
    }

    return { wallets, walletToEntity, scoreByWallet, statsByWallet, fundedByWallet };
  } catch {
    return null; // any failure -> caller falls back to live resolve
  }
}

/**
 * Serialize a SmartSet into the compact blob and upsert it under SNAPSHOT_KEY.
 * Best-effort: no-op when Supabase is unconfigured or the set is empty, and
 * never throws (a write failure simply means the next caller re-resolves).
 */
export async function writeSnapshot(set: SmartSet): Promise<void> {
  if (!isSupabaseConfigured()) return;
  if (!set || set.wallets.size === 0) return; // don't persist an empty snapshot

  try {
    const blob: SnapshotBlob = {
      at: Date.now(),
      w: Array.from(set.wallets),
      // Only wallets that actually belong to a cluster appear in the entity map;
      // unmapped wallets are their own entity (rebuilt via `?? wallet` callers).
      e: Array.from(set.walletToEntity.entries()),
      s: Array.from(set.scoreByWallet.entries()),
      st: Array.from(set.statsByWallet.entries()).map(
        ([w, st]) => [w, st.roiPct, st.winRate, st.realizedPnl] as [
          string,
          number | null,
          number | null,
          number
        ]
      ),
      // Smart inheritance map; omitted when there are no inherited wallets.
      fb: set.fundedByWallet ? Array.from(set.fundedByWallet.entries()) : [],
    };

    const supabase = getSupabase();
    await supabase.from('indexer_state').upsert(
      { key: SNAPSHOT_KEY, value: blob, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  } catch (error) {
    console.error('[SMART-SET] Failed to persist snapshot:', (error as Error).message);
  }
}
