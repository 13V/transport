/**
 * ALERT COOLDOWNS — shared per-mint cooldown persistence.
 *
 * A tiny, self-contained store over the `indexer_state` table. Each cooldown
 * "key" maps to a JSON object of mint -> last-alert epoch-ms, exactly mirroring
 * the blob shape that lib/alerts/detect.ts already persists for its momentum /
 * exit cooldowns. The real-time webhook alert path uses this so a burst alert
 * for a mint isn't re-sent every few seconds while the burst is still live.
 *
 * Resilient by design: when Supabase isn't configured (or any read/write
 * fails), reads return {} and writes no-op. A cooldown failure must never break
 * ingestion or alerting — at worst we under- or over-suppress an alert.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';

/**
 * Read a { mint: epochMs } cooldown blob from indexer_state for `key`.
 * Returns {} when Supabase is unconfigured or on any error.
 */
export async function readCooldowns(key: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!isSupabaseConfigured()) return out;

  try {
    const supabase = getSupabase();
    const { data: stateRow } = await supabase
      .from('indexer_state')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    const value = (stateRow?.value ?? {}) as Record<string, unknown>;
    for (const [mint, ts] of Object.entries(value)) {
      const n = Number(ts);
      if (Number.isFinite(n)) out[mint] = n;
    }
  } catch (error) {
    console.error(`[ALERT] Failed to read cooldowns (${key}):`, (error as Error).message);
  }
  return out;
}

/**
 * Persist a { mint: epochMs } cooldown blob to indexer_state under `key`.
 * Best-effort: no-op when Supabase is unconfigured, never throws.
 */
export async function writeCooldowns(
  key: string,
  map: Record<string, number>
): Promise<void> {
  if (!isSupabaseConfigured()) return;

  try {
    const supabase = getSupabase();
    await supabase.from('indexer_state').upsert(
      { key, value: map, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  } catch (error) {
    console.error(`[ALERT] Failed to persist cooldowns (${key}):`, (error as Error).message);
  }
}
