/**
 * CHAIN DISCOVERY  (ported from gmgn's seed-wallets.js `chainDiscover`)
 *
 * The highest-signal way to grow the smart-wallet set: instead of scanning
 * random coins, follow the wallets that are ALREADY proven winners. Take our
 * top verified wallets, look at the coins they recently BOUGHT, and fully
 * ingest those coins — capturing every other wallet trading alongside the
 * smart money. Those co-traders are disproportionately smart too.
 *
 * Captured wallets land in the backlog; the deep-scan worker then verifies
 * them. Quality compounds: winners point at the next winners.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { fullScanCoin } from './graduations';

export interface ChainDiscoveryResult {
  ok: boolean;
  seedWinners: number;
  coinsFollowed: number;
  coinsScanned: number;
  walletsCaptured: number;
  elapsedMs: number;
  error?: string;
  debug?: Record<string, unknown>;
}

export interface ChainDiscoveryOptions {
  maxWinners?: number; // how many top verified wallets to follow
  maxCoins?: number; // coins to fully scan this run
  lookbackDays?: number; // how recent the winners' buys must be
  maxTxsPerCoin?: number;
  rescanAfterHours?: number;
  timeBudgetMs?: number;
}

export async function runChainDiscovery(
  opts: ChainDiscoveryOptions = {}
): Promise<ChainDiscoveryResult> {
  const start = Date.now();
  const maxWinners = opts.maxWinners ?? 30;
  const maxCoins = opts.maxCoins ?? 4;
  const lookbackDays = opts.lookbackDays ?? 14;
  const maxTxsPerCoin = opts.maxTxsPerCoin ?? 3000;
  const rescanAfterHours = opts.rescanAfterHours ?? 24;
  const timeBudgetMs = opts.timeBudgetMs ?? 50_000;

  const blank = (error?: string): ChainDiscoveryResult => ({
    ok: !error,
    seedWinners: 0,
    coinsFollowed: 0,
    coinsScanned: 0,
    walletsCaptured: 0,
    elapsedMs: Date.now() - start,
    error,
  });

  if (!isSupabaseConfigured()) return blank('Supabase not configured');
  if (!process.env.HELIUS_API_KEY) return blank('HELIUS_API_KEY missing');

  const supabase = getSupabase();

  // 1. Our proven winners — verified wallets with positive all-time ROI.
  const { data: winners, error: wErr } = await supabase
    .from('wallet_stats')
    .select('wallet, roi_pct')
    .eq('verified', true)
    .gt('roi_pct', 0)
    .order('roi_pct', { ascending: false })
    .limit(maxWinners);
  if (wErr) return blank(`winner fetch failed: ${wErr.message}`);
  const winnerWallets = (winners ?? []).map((r: any) => r.wallet);
  if (winnerWallets.length === 0) {
    return { ...blank(), ok: true, error: 'No verified winners yet — run the deep-scan first' };
  }

  // 2. Coins those winners recently bought.
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const { data: buys, error: bErr } = await supabase
    .from('trades')
    .select('token_mint')
    .in('wallet', winnerWallets)
    .eq('trade_type', 'BUY')
    .gte('block_time', since)
    .limit(3000);
  if (bErr) return blank(`buy fetch failed: ${bErr.message}`);

  let tokens = [...new Set((buys ?? []).map((b: any) => b.token_mint))];

  // Skip coins we've already fully ingested recently.
  if (tokens.length > 0) {
    const { data: known } = await supabase
      .from('coins')
      .select('mint, full_scanned_at')
      .in('mint', tokens);
    const cutoff = Date.now() - rescanAfterHours * 3_600_000;
    const recent = new Set(
      (known ?? [])
        .filter((r: any) => r.full_scanned_at && new Date(r.full_scanned_at).getTime() > cutoff)
        .map((r: any) => r.mint)
    );
    tokens = tokens.filter((t) => !recent.has(t));
  }

  // 3. Fully ingest each followed coin → capture every co-trader.
  let coinsScanned = 0;
  let walletsCaptured = 0;
  const detail: Array<Record<string, unknown>> = [];
  for (const mint of tokens) {
    if (coinsScanned >= maxCoins) break;
    if (Date.now() - start > timeBudgetMs) break;
    try {
      const res = await fullScanCoin(supabase, mint, undefined, maxTxsPerCoin);
      coinsScanned += 1;
      walletsCaptured += res.wallets;
      detail.push({ mint, wallets: res.wallets, trades: res.trades });
    } catch (err) {
      console.error(`[CHAIN] scan failed for ${mint}:`, (err as Error).message);
    }
  }

  await supabase.from('indexer_state').upsert(
    {
      key: 'last_chain_discovery',
      value: { at: new Date().toISOString(), seedWinners: winnerWallets.length, coinsScanned, walletsCaptured },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' }
  );

  return {
    ok: true,
    seedWinners: winnerWallets.length,
    coinsFollowed: tokens.length,
    coinsScanned,
    walletsCaptured,
    elapsedMs: Date.now() - start,
    debug: { detail },
  };
}
