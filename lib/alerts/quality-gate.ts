/**
 * ALERT QUALITY GATE — signal, not noise.
 *
 * The broadcast alert channel is the product's loudest surface, and every
 * low-quality ping it sends burns user trust. This gate sits IMMEDIATELY before
 * the burst-alert sends (app/api/helius/webhook/route.ts) and suppresses an
 * alert when ANY of:
 *
 *   1. PROVEN-LOSER TYPE — the burst's signal type has MEASURED outcomes
 *      (getBurstStats byType, 72h window) with enough samples
 *      (n >= ALERT_TYPE_MIN_N, default 30) AND a 1h hit-rate below
 *      ALERT_TYPE_MIN_HIT (default 25, PERCENT units — matching getBurstStats'
 *      hitRate1h output). An UNMEASURED or thin-sample type always passes: we
 *      only silence what the data has proven to lose, never what it hasn't
 *      judged yet.
 *   2. WEAK CONVICTION — zero S-tier buyers in the burst AND fewer than
 *      ALERT_MIN_BUYERS (default 3, same env the detect-path gate uses) distinct
 *      buyers. One elite wallet OR real convergence is enough; neither is noise.
 *   3. BUNDLE RISK — bundleFlag === true (the token is flagged bundled/sniped,
 *      the user's one real pump.fun risk). Only an EXPLICIT true suppresses;
 *      undefined/null means "unchecked" and passes.
 *
 * Kill-switch: ALERT_QUALITY_GATE ('1' default = on; '0' bypasses entirely).
 *
 * FAIL OPEN: any internal error returns ok:true. A missed suppression is noise;
 * a gate bug that silences ALL alerts is an outage — the worse failure. The
 * stats dependency (getBurstStats) is itself no-throw, but we still wrap.
 *
 * getBurstStats(72) is cached module-level with a 10-min TTL (and in-flight
 * coalescing) so a webhook storm doesn't re-scan live_bursts per alert.
 */

import { getBurstStats, type BurstStats } from '../indexer/burst-outcomes';

/** The minimal burst shape the gate judges (subset of LiveBurst). */
export interface GateBurst {
  type?: string | null;
  tiers?: (string | null)[] | null;
  buyers?: number;
  bundleFlag?: boolean | null;
}

export interface GateVerdict {
  ok: boolean;
  /** Human-readable suppression reason (only set when ok === false). */
  reason?: string;
}

// 72h outcome window: wide enough that per-type n clears the min-sample bar at
// current burst volume, narrow enough to track regime shifts within ~3 days.
const STATS_WINDOW_HOURS = 72;
const STATS_TTL_MS = 10 * 60_000;

let statsCache: { at: number; stats: BurstStats } | null = null;
let statsInflight: Promise<BurstStats> | null = null;

/** TEST HOOK: reset the module-level stats cache so tests stay deterministic. */
export function __resetQualityGateCache(): void {
  statsCache = null;
  statsInflight = null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Cached read of the measured per-type outcomes. Coalesces concurrent callers
 * onto one in-flight fetch; on a fetch failure serves the STALE cache if one
 * exists (stale stats beat no stats), else rethrows into shouldAlert's
 * fail-open catch.
 */
async function getStatsCached(): Promise<BurstStats> {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.stats;
  if (!statsInflight) {
    statsInflight = getBurstStats(STATS_WINDOW_HOURS)
      .then((stats) => {
        statsCache = { at: Date.now(), stats };
        return stats;
      })
      .finally(() => {
        statsInflight = null;
      });
  }
  try {
    return await statsInflight;
  } catch (err) {
    if (statsCache) return statsCache.stats; // stale beats nothing
    throw err;
  }
}

/**
 * Should this burst be broadcast? Returns { ok: false, reason } to suppress.
 * Never throws — see FAIL OPEN above.
 */
export async function shouldAlert(burst: GateBurst): Promise<GateVerdict> {
  try {
    // Kill-switch: '0' bypasses every check (read per call, so flipping the env
    // takes effect without a redeploy on platforms with live env updates).
    if (process.env.ALERT_QUALITY_GATE === '0') return { ok: true };

    // --- 3. Bundle risk (cheapest check first; no stats needed). ---
    if (burst.bundleFlag === true) {
      return { ok: false, reason: 'token flagged bundled/sniped' };
    }

    // --- 2. Weak conviction: no S-tier AND too few buyers. ---
    const tiers = Array.isArray(burst.tiers) ? burst.tiers : [];
    const hasS = tiers.some((t) => t === 'S');
    const buyers = typeof burst.buyers === 'number' && Number.isFinite(burst.buyers)
      ? burst.buyers
      : 0;
    const minBuyers = envInt('ALERT_MIN_BUYERS', 3);
    if (!hasS && buyers < minBuyers) {
      return {
        ok: false,
        reason: `no S-tier buyer and only ${buyers} buyer${buyers === 1 ? '' : 's'} (< ${minBuyers})`,
      };
    }

    // --- 1. Proven-loser type (the only check that touches the DB/cache). ---
    // Missing type defaults to 'burst', matching live_bursts persistence.
    const type = burst.type ?? 'burst';
    const stats = await getStatsCached();
    const typeStats = stats.byType?.[type];
    const minN = envInt('ALERT_TYPE_MIN_N', 30);
    const minHit = envNum('ALERT_TYPE_MIN_HIT', 25); // percent, like hitRate1h
    if (
      typeStats &&
      typeStats.n >= minN &&
      typeStats.hitRate1h != null &&
      typeStats.hitRate1h < minHit
    ) {
      return {
        ok: false,
        reason: `type "${type}" is a proven loser (hit ${typeStats.hitRate1h}% < ${minHit}% over n=${typeStats.n})`,
      };
    }

    return { ok: true };
  } catch (err) {
    // FAIL OPEN — an alerting outage is worse than noise.
    console.error('[ALERT-GATE] gate errored, failing open:', (err as Error).message);
    return { ok: true };
  }
}
