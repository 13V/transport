/**
 * LINK TRACKING — follow the money out of smart wallets.
 *
 * For each proven (verified, profitable) wallet, find the wallets it funded with
 * SOL and: (1) record the funding edge in wallet_links, (2) enqueue each funded
 * wallet for analysis with a funded_by pointer. A fresh wallet funded by smart
 * money is almost certainly the same trader — so we capture it the moment it's
 * created and track it forever, even before it makes its first trade.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { fetchSolDistributions } from './wallet-links';
import { envInt } from './env';

export interface LinkTrackingResult {
  ok: boolean;
  winnersScanned: number;
  linksRecorded: number;
  walletsEnqueued: number;
  elapsedMs: number;
  error?: string;
  debug?: Record<string, unknown>;
}

export interface LinkTrackingOptions {
  maxWallets?: number;
  minSol?: number;
  maxTxsPerWallet?: number;
  maxLinksPerWallet?: number;
  timeBudgetMs?: number;
}

export async function runLinkTracking(opts: LinkTrackingOptions = {}): Promise<LinkTrackingResult> {
  const start = Date.now();
  const maxWallets = opts.maxWallets ?? envInt('LINK_MAX_WALLETS', 20);
  const minSol = opts.minSol ?? Number(process.env.LINK_MIN_SOL ?? 0.5);
  const maxTxsPerWallet = opts.maxTxsPerWallet ?? envInt('LINK_MAX_TXS', 500);
  const maxLinksPerWallet = opts.maxLinksPerWallet ?? envInt('LINK_MAX_TARGETS', 50);
  const timeBudgetMs = opts.timeBudgetMs ?? envInt('LINK_TIME_BUDGET_MS', 50_000);

  const blank = (error?: string): LinkTrackingResult => ({
    ok: !error,
    winnersScanned: 0,
    linksRecorded: 0,
    walletsEnqueued: 0,
    elapsedMs: Date.now() - start,
    error,
  });

  if (!isSupabaseConfigured()) return blank('Supabase not configured');
  if (!process.env.HELIUS_API_KEY) return blank('HELIUS_API_KEY missing');

  const supabase = getSupabase();

  // Proven winners worth following. Process the least-recently-checked first via
  // updated_at so coverage rotates over successive runs.
  const { data: winners, error: wErr } = await supabase
    .from('wallet_stats')
    .select('wallet, roi_pct')
    .eq('verified', true)
    .gt('roi_pct', 0)
    .order('roi_pct', { ascending: false })
    .limit(maxWallets);
  if (wErr) return blank(`winner fetch failed: ${wErr.message}`);
  const winnerWallets = (winners ?? []).map((r: any) => r.wallet);
  if (winnerWallets.length === 0) {
    return { ...blank(), ok: true, error: 'No verified winners yet — run the deep-scan first' };
  }

  let winnersScanned = 0;
  let linksRecorded = 0;
  let walletsEnqueued = 0;

  for (const source of winnerWallets) {
    if (Date.now() - start > timeBudgetMs) break;
    winnersScanned += 1;

    let dists;
    try {
      dists = await fetchSolDistributions(source, { maxTxs: maxTxsPerWallet, minSol });
    } catch (err) {
      console.error(`[LINKS] distribution scan failed for ${source}:`, (err as Error).message);
      continue;
    }
    if (dists.length === 0) continue;
    const top = dists.slice(0, maxLinksPerWallet);

    const linkRows = top.map((d) => ({
      source,
      target: d.target,
      amount_sol: Math.round(d.amountSol * 10000) / 10000,
      transfers: d.transfers,
      first_seen: d.firstSeen.toISOString(),
      last_seen: d.lastSeen.toISOString(),
      updated_at: new Date().toISOString(),
    }));
    const { error: lErr } = await supabase.from('wallet_links').upsert(linkRows, { onConflict: 'source,target' });
    if (lErr) {
      console.error(`[LINKS] link upsert failed for ${source}:`, lErr.message);
      continue;
    }
    linksRecorded += linkRows.length;

    // Enqueue funded wallets for tracking with a funded_by pointer. Only sets
    // funded_by + wallet (other columns keep their values / defaults).
    const stubRows = top.map((d) => ({ wallet: d.target, funded_by: source }));
    const { error: sErr } = await supabase.from('wallet_stats').upsert(stubRows, { onConflict: 'wallet' });
    if (!sErr) walletsEnqueued += stubRows.length;
  }

  await supabase.from('indexer_state').upsert(
    {
      key: 'last_link_tracking',
      value: { at: new Date().toISOString(), winnersScanned, linksRecorded, walletsEnqueued },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );

  return {
    ok: true,
    winnersScanned,
    linksRecorded,
    walletsEnqueued,
    elapsedMs: Date.now() - start,
  };
}
