#!/usr/bin/env node
/**
 * GMGN RE-SCREEN OF VERIFIED WALLETS (runs in CI, NOT on Vercel)
 *
 * The standing gmgn-screen worker only screens the verified=false backlog, so the
 * verified/smart set never gets GMGN's all-position win rate (screen_win_rate) —
 * which is exactly what the bag-holder gate guard (lib/indexer/curation.ts) needs
 * to catch wallets whose realized win rate looks elite only because we ignore
 * their un-exited losing bags. This worker screens the VERIFIED set so the guard
 * has fresh data. Cheap (GMGN only, zero Helius).
 *
 * Requires on PATH: gmgn-cli (with GMGN_API_KEY in env).
 * Env:
 *   TRANSPORT_URL  e.g. https://transport-topaz-eight.vercel.app
 *   CRON_SECRET    matches transport's CRON_SECRET (if set)
 *   GMGN_API_KEY   for gmgn-cli
 *   MAX            top-score verified wallets to cover per run (default 400)
 *   BATCH          POST batch size to the ingest (default 40)
 *   RATE_LIMIT_MS  delay between gmgn-cli calls (default 1500)
 *   REFRESH        '1' = re-screen even already-screened wallets (keeps data fresh);
 *                  unset = skip already-screened (pure backfill of new verifieds)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BASE = (process.env.TRANSPORT_URL || 'https://transport-topaz-eight.vercel.app').replace(/\/$/, '');
const SECRET = process.env.CRON_SECRET || '';
const CHAIN = process.env.CHAIN || 'sol';
const MAX = Number(process.env.MAX || 400);
const BATCH = Number(process.env.BATCH || 40);
const GAP_MS = Number(process.env.RATE_LIMIT_MS || 1500);
const REFRESH = process.env.REFRESH === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gmgnScreen(wallet) {
  for (let a = 0; a < 3; a++) {
    try {
      const { stdout } = await exec('gmgn-cli', ['portfolio', 'stats', '--chain', CHAIN, '--wallet', wallet, '--period', 'all'], { timeout: 25000, maxBuffer: 8 << 20 });
      const j = JSON.parse(stdout); const d = Array.isArray(j) ? j[0] : j;
      if (!d?.wallet_address) return null;
      const ps = d.pnl_stat || {};
      return {
        address: wallet,
        winRate: Number(ps.winrate || 0),
        realizedProfitUsd: Number(d.realized_profit || 0),
        tokenCount: Number(ps.token_num || 0),
        tradeCount: Number(d.buy || 0) + Number(d.sell || 0),
        avgHoldSeconds: Math.round(Number(ps.avg_holding_period || 0)),
      };
    } catch (e) {
      const msg = String(e?.stdout || e?.message || e);
      if (/RATE_LIMIT|reset_at|429|too many/i.test(msg)) { await sleep(90000); continue; }
      return null;
    }
  }
  return null;
}

async function postBatch(wallets) {
  if (!wallets.length) return;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(`${BASE}/api/ingest/wallet-stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(SECRET ? { Authorization: `Bearer ${SECRET}` } : {}) },
        body: JSON.stringify({ source: 'gmgn-rescreen-verified', wallets }),
      });
      if (r.ok) { const j = await r.json(); process.stdout.write(` posted=${j.upserted}(pass=${j.screenPass})`); return; }
    } catch { /* retry */ }
    await sleep(2000 * (a + 1));
  }
  process.stdout.write(' POST-FAILED');
}

async function pageWallets(page, pageSize) {
  const r = await fetch(`${BASE}/api/smart-money/list?verified=1&sort=score&pageSize=${pageSize}&page=${page}`,
    { headers: SECRET ? { Authorization: `Bearer ${SECRET}` } : {} });
  if (!r.ok) return [];
  const j = await r.json();
  const arr = j.wallets || (Array.isArray(j) ? j : []);
  return arr.map(w => w.address || w.wallet).filter(Boolean);
}

(async () => {
  // In backfill mode (REFRESH unset) skip wallets already carrying a GMGN screen.
  let screened = new Set();
  if (!REFRESH) {
    try {
      const r = await fetch(`${BASE}/api/admin/gmgn-calibration?dump=1&limit=8000`, { headers: SECRET ? { Authorization: `Bearer ${SECRET}` } : {} });
      if (r.ok) (await r.json()).wallets.forEach(w => screened.add(w.wallet));
    } catch {}
  }
  console.log(`mode=${REFRESH ? 'refresh' : 'backfill'} alreadyScreened=${screened.size} target=${MAX}`);

  const todo = [];
  for (let page = 1; page <= 40 && todo.length < MAX; page++) {
    const ws = await pageWallets(page, 100);
    if (!ws.length) break;
    for (const w of ws) if (REFRESH || !screened.has(w)) todo.push(w);
  }
  console.log(`screening ${todo.length} top-score verified wallets via GMGN (no Helius)...`);

  let batch = [], done = 0, ok = 0;
  for (const w of todo) {
    const s = await gmgnScreen(w); done++;
    if (s) { batch.push(s); ok++; }
    if (batch.length >= BATCH) { await postBatch(batch); batch = []; }
    if (done % 25 === 0) process.stdout.write(`\n[${done}/${todo.length} ok=${ok}]`);
    await sleep(GAP_MS);
  }
  await postBatch(batch);
  console.log(`\nDONE: screened ${ok}/${done} verified wallets. Bag-holder guard has fresh GMGN data.`);
})();
