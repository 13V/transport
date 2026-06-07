/**
 * HELIUS DAILY CREDIT CIRCUIT-BREAKER
 *
 * A persistent, per-UTC-day cost ceiling over the Helius Enhanced Transactions
 * API. The drain/indexer/graduations/chain-discovery crons hammer
 * `/addresses/{addr}/transactions` (100 credits/page), and the drain re-scans
 * wallets repeatedly — historically burning millions of credits a day. This
 * module gives every page fetch a hard spend check so a runaway run can't blow
 * past the cap.
 *
 * Storage: a single `indexer_state` row (same kv blob pattern as
 * lib/alerts/cooldowns.ts) under key `helius_credits`, holding
 * `{ day: 'YYYY-MM-DD', credits: number }`. When the UTC day rolls over the
 * tally resets.
 *
 * Cost-conscious by design — we do NOT read/write the DB on every page:
 *   - The day total is read once and cached in-process for ~30s.
 *   - Spend is accumulated in an in-process tally and flushed to the DB only
 *     periodically (every ~1000 credits or ~15s), or explicitly at cron end.
 *
 * Fully resilient: any indexer_state failure logs once and degrades to an
 * in-process-only daily tally, so even with the DB unreachable a single run is
 * still bounded by the cap.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';

const STATE_KEY = 'helius_credits';

const READ_CACHE_TTL_MS = 30_000; // re-read the DB day-total at most this often
const FLUSH_INTERVAL_MS = 15_000; // flush the in-process tally at least this often
const FLUSH_CREDIT_THRESHOLD = 1000; // ...or once this many unflushed credits accrue

interface CreditBlob {
  day: string;
  credits: number;
}

/** Current UTC day as 'YYYY-MM-DD'. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailyCap(): number {
  return Number(process.env.HELIUS_DAILY_CREDIT_CAP) || 500_000;
}

// In-process state. `dbCreditsAtRead` is the day total last read from the DB;
// `tally` is credits recorded since the last successful flush. The effective
// "spent today" is dbCreditsAtRead + tally (for the cached day).
let cachedDay = '';
let dbCreditsAtRead = 0;
let lastReadAt = 0;
let tally = 0; // unflushed, in-process credits
let lastFlushAt = 0;
let degraded = false; // DB unreachable -> in-process-only mode
let loggedDegrade = false;
let loggedCapReached = false;

/** Reset all in-process accounting when the UTC day changes. */
function rollDayIfNeeded(): void {
  const day = utcDay();
  if (day !== cachedDay) {
    cachedDay = day;
    dbCreditsAtRead = 0;
    lastReadAt = 0;
    tally = 0;
    lastFlushAt = 0;
    loggedCapReached = false;
  }
}

function logDegradeOnce(err: unknown): void {
  degraded = true;
  if (!loggedDegrade) {
    loggedDegrade = true;
    console.error(
      '[BUDGET] indexer_state unavailable — falling back to in-process-only daily tally:',
      (err as Error)?.message ?? err
    );
  }
}

/**
 * Refresh `dbCreditsAtRead` from the DB if the cache is stale. On any failure,
 * degrade to in-process-only mode (the existing tally still bounds the run).
 */
async function refreshDbTotal(): Promise<void> {
  if (degraded || !isSupabaseConfigured()) {
    if (!isSupabaseConfigured()) degraded = true;
    return;
  }
  if (Date.now() - lastReadAt < READ_CACHE_TTL_MS) return;

  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('indexer_state')
      .select('value')
      .eq('key', STATE_KEY)
      .maybeSingle();
    const blob = (data?.value ?? {}) as Partial<CreditBlob>;
    const day = utcDay();
    // Only trust the stored credits if they're for the current UTC day.
    dbCreditsAtRead = blob.day === day && Number.isFinite(Number(blob.credits))
      ? Number(blob.credits)
      : 0;
    lastReadAt = Date.now();
  } catch (err) {
    logDegradeOnce(err);
  }
}

/** Effective credits spent today (DB-known + unflushed in-process tally). */
function spentToday(): number {
  return dbCreditsAtRead + tally;
}

/**
 * Persist the current day total (dbCreditsAtRead + tally) to indexer_state and
 * fold the tally into dbCreditsAtRead on success. Best-effort: on failure we
 * degrade and keep the tally in-process so the run stays bounded.
 */
async function flush(): Promise<void> {
  if (tally <= 0) return;
  if (degraded || !isSupabaseConfigured()) {
    if (!isSupabaseConfigured()) degraded = true;
    return;
  }

  const day = utcDay();
  const newTotal = dbCreditsAtRead + tally;
  try {
    const supabase = getSupabase();
    await supabase.from('indexer_state').upsert(
      {
        key: STATE_KEY,
        value: { day, credits: newTotal } as CreditBlob,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );
    dbCreditsAtRead = newTotal;
    tally = 0;
    lastFlushAt = Date.now();
  } catch (err) {
    logDegradeOnce(err);
  }
}

/**
 * True when today's spend + `estCredits` is within the cap. Reads the day total
 * at most once per ~30s; otherwise answers from the in-process tally so there's
 * no DB read per page.
 */
export async function canSpend(estCredits = 100): Promise<boolean> {
  rollDayIfNeeded();
  await refreshDbTotal();
  return spentToday() + estCredits <= getDailyCap();
}

/**
 * Record credits actually spent on a successful Helius page. Increments the
 * in-process tally and flushes to the DB only periodically (every
 * ~FLUSH_CREDIT_THRESHOLD credits or ~FLUSH_INTERVAL_MS), never on every call.
 */
export async function recordSpend(credits = 100): Promise<void> {
  rollDayIfNeeded();
  tally += credits;
  if (tally >= FLUSH_CREDIT_THRESHOLD || Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) {
    await flush();
  }
}

/**
 * Flush any pending tally now — call at the end of a cron run so the last
 * partial batch of credits is persisted promptly.
 */
export async function flushHeliusSpend(): Promise<void> {
  rollDayIfNeeded();
  await flush();
}

/**
 * Guard helper for callers: returns false when fetching another page would
 * exceed the daily cap. Logs the cap-reached message once per run/day so a long
 * drain doesn't spam the logs.
 */
export async function guardHeliusPage(estCredits = 100): Promise<boolean> {
  const ok = await canSpend(estCredits);
  if (!ok && !loggedCapReached) {
    loggedCapReached = true;
    console.warn('[BUDGET] Helius daily cap reached, skipping');
  }
  return ok;
}
