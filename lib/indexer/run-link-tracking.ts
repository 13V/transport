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
  // Per-run caps raised to process MORE winners and discover MORE funded wallets
  // each run (a cheap discovery multiplier). All env-overridable. Helius spend
  // stays bounded by the daily credit circuit-breaker (guardHeliusPage in
  // wallet-links.ts) AND by timeBudgetMs, so raising these can only widen
  // coverage WITHIN the existing budget, never blow past it.
  const maxWallets = opts.maxWallets ?? envInt('LINK_MAX_WALLETS', 60);
  const minSol = opts.minSol ?? Number(process.env.LINK_MIN_SOL ?? 0.5);
  const maxTxsPerWallet = opts.maxTxsPerWallet ?? envInt('LINK_MAX_TXS', 500);
  const maxLinksPerWallet = opts.maxLinksPerWallet ?? envInt('LINK_MAX_TARGETS', 100);
  const timeBudgetMs = opts.timeBudgetMs ?? envInt('LINK_TIME_BUDGET_MS', 55_000);
  // Drained-winner prioritization: a verified winner whose balance is below this
  // (profits extracted / likely moved wallets) jumps the link-scan queue. Balance
  // comes free from the GMGN screen (native_balance) — no Helius balance calls.
  const drainedSol = Number(process.env.LINK_DRAINED_SOL ?? 1.0);

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

  // Probe optional columns so a pre-0022/0023 DB still works (rotation / drained
  // prioritization simply not applied). sol_balance is populated for FREE by the
  // GMGN screen (native_balance, via /api/ingest/wallet-stats) — no Helius here.
  const hasLinkTs = !(await supabase.from('wallet_stats').select('links_checked_at').limit(1)).error;
  const hasBalance = !(await supabase.from('wallet_stats').select('sol_balance').limit(1)).error;

  // Build the candidate list. DRAINED verified winners (balance below the
  // threshold — profits pulled / likely on a new wallet) come FIRST, ordered by
  // least-recently link-checked; the rest fill via the normal full-set rotation.
  const winnerWallets: string[] = [];
  const pushUnique = (rows: any[] | null | undefined) => {
    for (const r of rows ?? []) {
      if (winnerWallets.length >= maxWallets) break;
      if (!winnerWallets.includes(r.wallet)) winnerWallets.push(r.wallet);
    }
  };

  if (hasBalance && hasLinkTs) {
    const drained = await supabase
      .from('wallet_stats')
      .select('wallet')
      .eq('verified', true)
      .gt('roi_pct', 0)
      .lt('sol_balance', drainedSol) // nulls excluded — only confirmed-drained jump the queue
      .order('links_checked_at', { ascending: true, nullsFirst: true })
      .limit(maxWallets);
    pushUnique(drained.data);
  }
  if (winnerWallets.length < maxWallets) {
    let wq = supabase.from('wallet_stats').select('wallet').eq('verified', true).gt('roi_pct', 0);
    wq = hasLinkTs
      ? wq.order('links_checked_at', { ascending: true, nullsFirst: true })
      : wq.order('roi_pct', { ascending: false });
    const fill = await wq.limit(maxWallets);
    if (fill.error && winnerWallets.length === 0) return blank(`winner fetch failed: ${fill.error.message}`);
    pushUnique(fill.data);
  }
  if (winnerWallets.length === 0) {
    return { ...blank(), ok: true, error: 'No verified winners yet — run the deep-scan first' };
  }

  let winnersScanned = 0;
  let linksRecorded = 0;
  let walletsEnqueued = 0;
  const scanned: string[] = []; // every wallet we attempted — stamped to advance the rotation cursor

  for (const source of winnerWallets) {
    if (Date.now() - start > timeBudgetMs) break;
    winnersScanned += 1;
    scanned.push(source);

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

  // Advance the rotation cursor: stamp every wallet we attempted this run (even
  // those with no distributions or a transient error) so the next run moves on to
  // the least-recently-checked set and coverage sweeps the whole proven set.
  if (hasLinkTs && scanned.length) {
    await supabase
      .from('wallet_stats')
      .update({ links_checked_at: new Date().toISOString() })
      .in('wallet', scanned);
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
