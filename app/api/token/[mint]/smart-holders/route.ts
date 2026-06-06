/**
 * PROVEN SMART WALLETS IN A COIN
 *
 *   GET /api/token/{mint}/smart-holders
 *
 * Pulls a coin's full swap history (every wallet that bought/sold it), then
 * intersects those wallets with the VERIFIED smart-money set in wallet_stats
 * (verified=true). The result answers: "which proven smart wallets are in this
 * coin, and how are they doing on it?"
 *
 * Each holder pairs its all-time track record (wallet_stats.roi_pct) with its
 * realized PnL on THIS specific coin (from the per-coin trader analysis).
 *
 * Query params:
 *   ?max=600   transactions to scan (default 600, clamped 100..2000)
 */

import { NextRequest, NextResponse } from 'next/server';
import { analyzeTokenTraders } from '../../../../../lib/indexer/token-traders';
import { getSupabase, isSupabaseConfigured } from '../../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface SmartHolder {
  wallet: string;
  allTimeRoiPct: number | null;
  verified: boolean;
  pnlOnThisCoin: number;
  tokensRemaining: number;
  buys: number;
  sells: number;
}

/** Split an array into chunks of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mint: string }> }
) {
  const { mint } = await params;

  if (!mint || mint.length < 32 || mint.length > 64) {
    return NextResponse.json({ error: 'Invalid mint address' }, { status: 400 });
  }
  if (!process.env.HELIUS_API_KEY) {
    return NextResponse.json(
      { error: 'HELIUS_API_KEY missing — cannot fetch swaps' },
      { status: 503 }
    );
  }

  const { searchParams } = request.nextUrl;
  const max = Math.min(
    Math.max(parseInt(searchParams.get('max') || '600', 10) || 600, 100),
    2000
  );

  try {
    const result = await analyzeTokenTraders(mint, max);

    // Index this coin's traders by wallet so we can attach per-coin PnL to the
    // verified-smart wallets we find in the DB.
    const tradersByWallet = new Map(
      result.traders.map((t) => [t.wallet, t])
    );
    const wallets = [...tradersByWallet.keys()];

    let smartHolders: SmartHolder[] = [];

    // Intersect the coin's traders with the verified smart-money set. If the DB
    // isn't configured or the expected columns are missing, we degrade to an
    // empty smart-holder list but still report traderCount.
    if (isSupabaseConfigured() && wallets.length > 0) {
      try {
        const supabase = getSupabase();
        const seen = new Set<string>();

        for (const part of chunk(wallets, 200)) {
          const { data, error } = await supabase
            .from('wallet_stats')
            .select('wallet, roi_pct, verified')
            .eq('verified', true)
            .in('wallet', part);

          if (error) throw error;

          for (const row of data ?? []) {
            const wallet = row.wallet as string;
            if (seen.has(wallet)) continue;
            const trader = tradersByWallet.get(wallet);
            if (!trader) continue;
            seen.add(wallet);

            smartHolders.push({
              wallet,
              allTimeRoiPct:
                typeof row.roi_pct === 'number' ? row.roi_pct : null,
              verified: Boolean(row.verified),
              pnlOnThisCoin: trader.realizedPnl,
              tokensRemaining: trader.tokensRemaining,
              buys: trader.buys,
              sells: trader.sells,
            });
          }
        }

        smartHolders.sort((a, b) => b.pnlOnThisCoin - a.pnlOnThisCoin);
      } catch (dbError) {
        // Resilient to missing columns / table issues: keep traderCount, drop
        // the smart-holder intersection rather than failing the whole request.
        console.error(`[SMART-HOLDERS] DB lookup failed for ${mint}:`, dbError);
        smartHolders = [];
      }
    }

    return NextResponse.json(
      {
        mint: result.mint,
        traderCount: result.traderCount,
        smartHolderCount: smartHolders.length,
        smartHolders,
      },
      { headers: { 'Cache-Control': 'public, max-age=120' } }
    );
  } catch (error) {
    console.error(`[SMART-HOLDERS] failed for ${mint}:`, error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
