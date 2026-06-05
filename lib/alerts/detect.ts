/**
 * ALERT DETECTION
 *
 * Scans the indexer's freshly-written data since the last run and emits alerts
 * for two events:
 *   - New BUYs by curated "smart" wallets (verified + clears the smart-money bar)
 *   - New funding links between wallets (SOL flowing winner → fresh wallet)
 *
 * A cursor in indexer_state ('last_alert') tracks the last timestamp seen for
 * each stream so successive runs don't re-alert. Each section is wrapped in its
 * own try/catch so a missing column or table degrades gracefully (returns 0)
 * instead of aborting the whole run.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';
import { getSmartCriteria, isSmartWallet, CuratableStat } from '../indexer/curation';
import { sendAlert } from './notifier';

interface AlertCursor {
  lastBuyAt: string;
  lastFundingAt: string;
}

const STATE_KEY = 'last_alert';
const ALERT_CAP = 25;
const WALLET_CHUNK = 200;

function short(s: string): string {
  return (s || '').slice(0, 6);
}

export async function detectAndAlert(): Promise<{ buys: number; fundings: number }> {
  if (!isSupabaseConfigured()) {
    return { buys: 0, fundings: 0 };
  }

  const supabase = getSupabase();
  const now = new Date();
  const defaultSince = new Date(now.getTime() - 3600_000).toISOString();

  // Load cursor.
  let lastBuyAt = defaultSince;
  let lastFundingAt = defaultSince;
  try {
    const { data: stateRow } = await supabase
      .from('indexer_state')
      .select('value')
      .eq('key', STATE_KEY)
      .maybeSingle();
    const value = (stateRow?.value ?? {}) as Partial<AlertCursor>;
    if (typeof value.lastBuyAt === 'string') lastBuyAt = value.lastBuyAt;
    if (typeof value.lastFundingAt === 'string') lastFundingAt = value.lastFundingAt;
  } catch (error) {
    console.error('[ALERT] Failed to read cursor:', (error as Error).message);
  }

  let buys = 0;
  let fundings = 0;
  let maxBuyAt = lastBuyAt;
  let maxFundingAt = lastFundingAt;

  // ---- New smart BUYs ----
  try {
    const criteria = getSmartCriteria();

    const { data: statRows, error: statErr } = await supabase
      .from('wallet_stats')
      .select(
        'wallet, realized_pnl, roi_pct, invested_sol, win_rate, total_trades, tokens_traded, last_trade_at, seeded'
      )
      .eq('verified', true);
    if (statErr) throw statErr;

    const smartWallets = (statRows ?? [])
      .filter((r) => {
        const stat: CuratableStat = {
          realizedPnl: Number(r.realized_pnl ?? 0),
          roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
          investedSol: r.invested_sol == null ? null : Number(r.invested_sol),
          winRate: Number(r.win_rate ?? 0),
          totalTrades: Number(r.total_trades ?? 0),
          tokensTraded: Number(r.tokens_traded ?? 0),
          lastTradeAt: r.last_trade_at ?? null,
          seeded: Boolean(r.seeded),
        };
        return isSmartWallet(stat, criteria, now.getTime());
      })
      .map((r) => r.wallet as string);

    if (smartWallets.length > 0) {
      const newBuys: Array<{ wallet: string; token_mint: string; amount: number; price: number; block_time: string }> = [];

      for (let i = 0; i < smartWallets.length; i += WALLET_CHUNK) {
        const chunk = smartWallets.slice(i, i + WALLET_CHUNK);
        const { data: tradeRows, error: tradeErr } = await supabase
          .from('trades')
          .select('wallet, token_mint, amount, price, block_time')
          .eq('trade_type', 'BUY')
          .in('wallet', chunk)
          .gt('block_time', lastBuyAt)
          .order('block_time', { ascending: false })
          .limit(100);
        if (tradeErr) throw tradeErr;
        for (const t of tradeRows ?? []) {
          newBuys.push({
            wallet: t.wallet as string,
            token_mint: t.token_mint as string,
            amount: Number(t.amount ?? 0),
            price: Number(t.price ?? 0),
            block_time: t.block_time as string,
          });
        }
      }

      // Newest first overall.
      newBuys.sort((a, b) => (a.block_time < b.block_time ? 1 : a.block_time > b.block_time ? -1 : 0));

      for (const t of newBuys) {
        if (t.block_time > maxBuyAt) maxBuyAt = t.block_time;
        if (buys < ALERT_CAP) {
          const sol = (t.amount * t.price).toFixed(2);
          await sendAlert(
            `🟢 Smart BUY: ${short(t.wallet)}… → ${short(t.token_mint)}… (${sol} SOL)`
          );
        }
        buys += 1;
      }
    }
  } catch (error) {
    console.error('[ALERT] Smart-buy detection failed:', (error as Error).message);
  }

  // ---- New fundings ----
  try {
    const { data: linkRows, error: linkErr } = await supabase
      .from('wallet_links')
      .select('source, target, amount_sol, last_seen')
      .gt('last_seen', lastFundingAt)
      .order('last_seen', { ascending: false })
      .limit(50);
    if (linkErr) throw linkErr;

    for (const l of linkRows ?? []) {
      const lastSeen = l.last_seen as string;
      if (lastSeen > maxFundingAt) maxFundingAt = lastSeen;
      if (fundings < ALERT_CAP) {
        await sendAlert(
          `🔗 ${short(l.source as string)}… funded ${short(l.target as string)}… (${l.amount_sol} SOL)`
        );
      }
      fundings += 1;
    }
  } catch (error) {
    console.error('[ALERT] Funding detection failed:', (error as Error).message);
  }

  // ---- Persist cursor ----
  try {
    const nowIso = now.toISOString();
    const cursor: AlertCursor = {
      lastBuyAt: maxBuyAt > lastBuyAt ? maxBuyAt : nowIso,
      lastFundingAt: maxFundingAt > lastFundingAt ? maxFundingAt : nowIso,
    };
    await supabase.from('indexer_state').upsert(
      {
        key: STATE_KEY,
        value: cursor,
        updated_at: nowIso,
      },
      { onConflict: 'key' }
    );
  } catch (error) {
    console.error('[ALERT] Failed to persist cursor:', (error as Error).message);
  }

  return { buys, fundings };
}
