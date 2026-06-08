#!/usr/bin/env node
/**
 * GMGN SCREEN WORKER (runs in CI, NOT on Vercel)
 *
 * The cheap pre-screen: pulls the wallet backlog from transport, asks GMGN for
 * each wallet's precomputed PnL via gmgn-cli (≈1 call per batch instead of one
 * Helius call per wallet), and POSTs the results back so transport can flag the
 * promising wallets for accurate Helius verification.
 *
 * Requires on PATH: gmgn-cli (with GMGN_API_KEY in env).
 * Env:
 *   TRANSPORT_URL  e.g. https://transport-topaz-eight.vercel.app
 *   CRON_SECRET    matches transport's CRON_SECRET (if set)
 *   GMGN_API_KEY   for gmgn-cli
 *   BATCH          wallets per gmgn-cli call (default 1; see note below)
 *   MAX_WALLETS    cap per run (default 200)
 *   RATE_LIMIT_MS  delay between gmgn-cli calls (default 2500)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TRANSPORT_URL = (process.env.TRANSPORT_URL || '').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET || '';
const CHAIN = process.env.CHAIN || 'sol';
// gmgn-cli v1.4.3 `portfolio stats` returns ONLY the first wallet's stats when
// given multiple --wallet flags, so batching silently dropped 4 of every 5
// wallets. Screen one wallet per call until the CLI supports true multi-wallet.
const BATCH = parseInt(process.env.BATCH || '1', 10);
const MAX_WALLETS = parseInt(process.env.MAX_WALLETS || '200', 10);
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || '2500', 10);

if (!TRANSPORT_URL) {
  console.error('TRANSPORT_URL is required');
  process.exit(1);
}

const authHeaders = CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gmgnCli(args) {
  const { stdout } = await execFileAsync('gmgn-cli', [...args, '--raw'], {
    timeout: 30000,
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });
  const trimmed = (stdout || '').trim();
  const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter((i) => i >= 0);
  if (starts.length === 0) return {};
  return JSON.parse(trimmed.slice(Math.min(...starts)));
}

async function fetchBacklog() {
  const res = await fetch(`${TRANSPORT_URL}/api/ingest/wallet-stats?limit=${MAX_WALLETS}`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error(`backlog fetch failed: ${res.status}`);
  const json = await res.json();
  return json.wallets || [];
}

async function postResults(wallets) {
  const res = await fetch(`${TRANSPORT_URL}/api/ingest/wallet-stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ source: 'gmgn', wallets }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ingest failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const backlog = await fetchBacklog();
  console.log(`Backlog: ${backlog.length} wallets to screen`);
  if (backlog.length === 0) return;

  const results = [];
  for (let i = 0; i < backlog.length; i += BATCH) {
    const batch = backlog.slice(i, i + BATCH);
    const walletArgs = batch.flatMap((w) => ['--wallet', w]);
    try {
      const out = await gmgnCli(['portfolio', 'stats', '--chain', CHAIN, ...walletArgs, '--period', '30d']);
      const list = Array.isArray(out) ? out : [out];
      for (const s of list) {
        if (!s?.wallet_address) continue;
        results.push({
          address: s.wallet_address,
          winRate: s.pnl_stat?.winrate ?? 0,
          realizedProfitUsd: Number(s.realized_profit ?? 0),
          tokenCount: s.pnl_stat?.token_num ?? 0,
          tradeCount: (s.buy ?? 0) + (s.sell ?? 0),
          avgHoldSeconds: Math.round(s.pnl_stat?.avg_holding_period ?? 0),
        });
      }
    } catch (err) {
      console.error(`batch ${i / BATCH} failed: ${err.message}`);
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`Screened ${results.length} wallets, posting...`);
  if (results.length > 0) console.log(await postResults(results));
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
