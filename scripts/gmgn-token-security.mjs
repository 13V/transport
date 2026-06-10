#!/usr/bin/env node
/**
 * GMGN TOKEN-SECURITY WORKER (runs in CI, NOT on Vercel)
 *
 * The rug/bundle avoidance data path: pulls the recent-burst mints that still
 * need a security row from transport, asks GMGN per token for security + info
 * (bundler/sniper wallet counts, holder concentration, honeypot/taxes, creator)
 * and the CREATOR's holdings history (serial-rugger detection — same heuristic
 * as gmgn/src/qualifier.js: a creator position that sold for profit and now sits
 * near zero counts as a rug pattern), then POSTs results back. Zero Helius.
 *
 * Requires on PATH: gmgn-cli (with GMGN_API_KEY in env).
 * Env:
 *   TRANSPORT_URL   e.g. https://transport-topaz-eight.vercel.app
 *   CRON_SECRET     matches transport's CRON_SECRET
 *   GMGN_API_KEY    for gmgn-cli
 *   MAX_TOKENS      cap per run (default 60)
 *   RATE_LIMIT_MS   delay between gmgn-cli calls (default 1300)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BASE = (process.env.TRANSPORT_URL || '').replace(/\/$/, '');
const SECRET = process.env.CRON_SECRET || '';
const CHAIN = process.env.CHAIN || 'sol';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 60);
const GAP_MS = Number(process.env.RATE_LIMIT_MS || 1300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!BASE) { console.error('TRANSPORT_URL missing'); process.exit(1); }

const auth = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};
const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Run gmgn-cli and parse its JSON stdout; 1 retry on rate-limit with backoff. */
async function cli(args) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await exec('gmgn-cli', args, { timeout: 25000, maxBuffer: 8 << 20 });
      return JSON.parse(stdout);
    } catch (e) {
      const msg = String(e?.stdout || e?.message || e);
      if (/RATE_LIMIT|reset_at|too many/i.test(msg)) { await sleep(90000); continue; }
      throw e;
    }
  }
  throw new Error('rate-limited twice');
}

// Per-run creator cache: bursts often share creators (serial deployers — the
// exact people this exists to catch), so don't re-pull the same history.
const creatorCache = new Map();

/** Count rug-pattern tokens in a creator's holdings (qualifier.js heuristic). */
async function creatorHistory(creator) {
  if (!creator) return { rugs: null, tokens: null };
  if (creatorCache.has(creator)) return creatorCache.get(creator);
  let out = { rugs: null, tokens: null };
  try {
    const holdingsData = await cli([
      'portfolio', 'holdings', '--chain', CHAIN, '--wallet', creator,
      '--limit', '20', '--order-by', 'last_active_timestamp', '--direction', 'desc',
    ]);
    await sleep(GAP_MS);
    const holdings = holdingsData?.holdings || holdingsData?.data?.holdings || holdingsData?.list || holdingsData?.data?.list || [];
    if (Array.isArray(holdings) && holdings.length) {
      let rugs = 0;
      for (const h of holdings) {
        const avgCost = toNum(h.avg_cost ?? h.avgCost);
        const currentValue = toNum(h.usd_value ?? h.value ?? h.current_value);
        const totalProfit = toNum(h.total_profit ?? h.realized_profit);
        // Rug pattern: creator sold for profit and the position is now ~worthless.
        if (avgCost > 0 && currentValue < avgCost * 0.05 && totalProfit > 0) rugs++;
      }
      out = { rugs, tokens: holdings.length };
    }
  } catch { /* creator history is best-effort */ }
  creatorCache.set(creator, out);
  return out;
}

/** Fetch security + info for one mint and shape the ingest payload entry. */
async function fetchToken(mint) {
  const security = await cli(['token', 'security', '--chain', CHAIN, '--address', mint]);
  await sleep(GAP_MS);
  let info = {};
  try {
    info = await cli(['token', 'info', '--chain', CHAIN, '--address', mint]);
    await sleep(GAP_MS);
  } catch { /* info is enrichment; security alone is still useful */ }

  const ts = security?.data || security || {};
  const ti = info?.data || info || {};
  const holderCount = toNum(ti.holder_count ?? ts.holder_count);
  const bundlerWallets = toNum(ti.wallet_tags_stat?.bundler_wallets);
  const creator = ti.creator || ti.deployer || ts.creator_address || ts.deployer || '';
  const hist = await creatorHistory(creator);

  return {
    mint,
    bundlerRate: holderCount > 0 ? bundlerWallets / holderCount : null,
    sniperCount: toNum(ti.wallet_tags_stat?.sniper_wallets) || null,
    top10HolderRate: toNum(ts.top_10_holder_rate || ti.top_10_holder_rate) || null,
    freshWalletRate: toNum(ti.wallet_tags_stat?.fresh_wallet_rate ?? ts.fresh_wallet_rate) || null,
    botDegenRate: toNum(ti.wallet_tags_stat?.bot_degen_rate ?? ts.bot_degen_rate) || null,
    rugRatio: toNum(ts.rug_ratio) || null,
    isHoneypot: !!(toNum(ts.is_honeypot) || toNum(ts.honeypot)),
    buyTax: toNum(ts.buy_tax) || null,
    sellTax: toNum(ts.sell_tax) || null,
    creator: creator || null,
    creatorRugCount: hist.rugs,
    creatorTokenCount: hist.tokens,
  };
}

(async () => {
  const res = await fetch(`${BASE}/api/ingest/token-security?limit=${MAX_TOKENS}`, { headers: auth });
  if (!res.ok) { console.error(`GET mints failed: ${res.status}`); process.exit(1); }
  const { mints = [] } = await res.json();
  console.log(`tokens needing security: ${mints.length}`);
  if (!mints.length) return;

  const tokens = [];
  let failed = 0;
  for (const mint of mints) {
    try {
      tokens.push(await fetchToken(mint));
    } catch (e) {
      failed++;
      console.error(`security fetch failed ${mint.slice(0, 8)}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  if (!tokens.length) { console.log(`nothing fetched (failed=${failed})`); return; }

  const post = await fetch(`${BASE}/api/ingest/token-security`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ tokens }),
  });
  const j = await post.json().catch(() => ({}));
  if (!post.ok) { console.error(`POST failed: ${post.status} ${JSON.stringify(j)}`); process.exit(1); }
  console.log(`DONE: upserted=${j.upserted} failed=${failed} creatorsCached=${creatorCache.size}`);
})();
