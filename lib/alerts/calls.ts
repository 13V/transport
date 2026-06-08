/**
 * PUBLIC PROOF FLYWHEEL — AUTO-POST SMART-MONEY CALLS + OUTCOMES
 *
 * Turns the durable burst record (live_bursts, migrations 0008/0009) into public,
 * self-compounding social proof:
 *
 *   postNewCalls()  — when a HIGH-CONVICTION burst fires, publicly post the CALL.
 *   postResults()   — once a call's outcome is measured and NOTABLE, post it.
 *
 * Both broadcast through the existing notifier (sendAlert → Telegram private +
 * public channel) AND to X/Twitter (postTweet, only when its 4 env vars are set).
 * Dedupe is owned here via the live_bursts.posted_call / posted_result flags
 * (migration 0009): a row is posted at most once, flipped only AFTER a successful
 * send, so a transient failure simply retries next cron tick.
 *
 * NO FAKE DATA: we only post bursts that actually fired and outcomes actually
 * measured from real price history (burst-outcomes.ts). Nothing is fabricated.
 *
 * Fully resilient + env-gated: safe no-op when Supabase/Telegram aren't
 * configured, and per-row try/catch so one bad row never aborts the batch or the
 * cron that called it.
 *
 * --- CONVICTION BAR (postNewCalls) ---------------------------------------------
 * A burst is "high-conviction" and eligible to post as a CALL when it is
 * finalized-enough (its window closed ≥ FINALIZE_MS ago, so it won't keep
 * growing) AND meets ANY of:
 *   - buyers >= MIN_BUYERS (4)  — broad smart-money agreement, OR
 *   - contains at least one 'S' tier wallet (top-tier conviction), OR
 *   - sol_total >= MIN_SOL (15◎) — large committed size.
 *
 * --- NOTABLE-RESULT RULE (postResults) -----------------------------------------
 * A measured outcome is worth posting when its CALL was already posted
 * (posted_call=true), not yet result-posted, AND it is genuinely noteworthy:
 *   - a 1h WIN: ret_1h >= WIN_RET_1H (50%), OR
 *   - the 24h leg is finalized and a strong move EITHER way:
 *     ret_24h >= WIN_RET_24H (100%) (big win) or ret_24h <= LOSS_RET_24H (-50%)
 *     (instructive loss — we post wins AND honest losses, never silently hide).
 */

import { sendAlert, escapeHtml } from './notifier';
import { postTweet } from './twitter';
import { tokenLinks } from '../trade-links';
import { getSupabase, isSupabaseConfigured } from '../supabase-client';

// --- Conviction bar (calls) ---
const MIN_BUYERS = 4;
const MIN_SOL = 15;
/** A burst window must have closed at least this long ago to count as final. */
const FINALIZE_MS = 5 * 60_000;

// --- Notable-result rule (outcomes) ---
const WIN_RET_1H = 50;
const WIN_RET_24H = 100;
const LOSS_RET_24H = -50;

// --- Per-run caps (anti-spam) ---
const MAX_CALLS_PER_RUN = 5;
const MAX_RESULTS_PER_RUN = 5;

interface CallRow {
  id: string;
  mint: string;
  symbol: string | null;
  buyers: number | null;
  sol_total: number | null;
  tiers: string[] | null;
  window_end: string | null;
}

interface ResultRow {
  id: string;
  mint: string;
  symbol: string | null;
  ret_1h: number | null;
  ret_24h: number | null;
  measured_24h_at: string | null;
}

function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

function fmtSol(n: number | null | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  if (v >= 100) return Math.round(v).toString();
  return (Math.round(v * 100) / 100).toString();
}

function fmtPct(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${r >= 0 ? '+' : ''}${r}%`;
}

/**
 * Sanitize an attacker-controlled, on-chain token symbol/name before it is
 * posted to X / Telegram from our verified account. Token metadata is fully
 * attacker-controlled, and the X path posts the plain text VERBATIM (no HTML
 * escaping), so a malicious symbol could inject @-mentions, links, newlines, or
 * control chars into our authored posts. We:
 *   - strip control chars + collapse all whitespace (no newlines/tabs),
 *   - drop @-mentions and #-hashtags (no riding our reach),
 *   - drop URL-like substrings (http(s)://, www., bare domains like foo.com/io),
 *   - allowlist to a safe charset (alphanumerics, space, and a few separators),
 *   - hard-cap the length.
 * Returns '' when nothing safe remains, so callers fall back to the mint.
 */
const MAX_SYMBOL_LEN = 24;

function sanitizeTokenText(raw: string | null | undefined): string {
  let s = String(raw ?? '');
  // Remove control chars (incl. newlines, tabs) and zero-width/format chars.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, ' ');
  // Strip anything URL-like: schemes, www., and bare domain tokens.
  s = s.replace(/\b(?:https?:\/\/|www\.)\S*/gi, ' ');
  s = s.replace(/\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?/gi, ' ');
  // Drop @mentions and #hashtags entirely (the marker and its handle/tag).
  s = s.replace(/[@#＠＃]\S*/g, ' ');
  // Allowlist a safe charset; everything else becomes a space.
  s = s.replace(/[^A-Za-z0-9 ._-]/g, ' ');
  // Collapse runs of whitespace and trim separators from the ends.
  s = s.replace(/\s+/g, ' ').replace(/^[ ._-]+|[ ._-]+$/g, '').trim();
  if (s.length > MAX_SYMBOL_LEN) s = s.slice(0, MAX_SYMBOL_LEN).trim();
  return s;
}

/** Display ticker: $SYM when known and safe, else a short mint. */
function ticker(symbol: string | null, mint: string): string {
  const safe = sanitizeTokenText((symbol ?? '').replace(/^\$/, ''));
  if (safe) return `$${safe}`;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/** Count 'S' tier entries (case-insensitive) in a tiers array. */
function sTierCount(tiers: string[] | null): number {
  if (!Array.isArray(tiers)) return 0;
  return tiers.filter((t) => typeof t === 'string' && t.trim().toUpperCase() === 'S').length;
}

/** Primary trade link for a mint (first 'trade' link), or the app token page. */
function tradeUrl(mint: string): string {
  const links = tokenLinks(mint);
  const trade = links.find((l) => l.kind === 'trade');
  return trade?.url ?? `${appBaseUrl()}/token/${mint}`;
}

/**
 * Broadcast one message to every configured public channel. The HTML variant
 * goes to Telegram (sendAlert); the plain variant goes to X (postTweet). Returns
 * true if the PRIMARY Telegram send succeeded (or Telegram is a no-op) — used to
 * gate the dedupe flag so undelivered posts retry next tick. The tweet is
 * best-effort and never gates the flag.
 */
async function broadcast(html: string, plain: string): Promise<boolean> {
  const tgOk = await sendAlert(html);
  // Best-effort; failures are logged inside postTweet and never throw.
  await postTweet(plain);
  return tgOk;
}

// ---------------------------------------------------------------------------
// POST NEW CALLS
// ---------------------------------------------------------------------------

/**
 * Find high-conviction, finalized bursts not yet posted as a call, post each to
 * Telegram + X, then flip posted_call=true (only after a successful Telegram
 * send). Capped per run; per-row resilient. Safe no-op when unconfigured.
 */
export async function postNewCalls(): Promise<{ posted: number }> {
  if (!isSupabaseConfigured()) return { posted: 0 };

  try {
    const supabase = getSupabase();
    const finalizedBefore = new Date(Date.now() - FINALIZE_MS).toISOString();

    // Over-select unposted finalized bursts; apply the conviction bar in JS so
    // the OR across buyers / S-tier / sol_total stays readable and documented.
    const read = await supabase
      .from('live_bursts')
      .select('id, mint, symbol, buyers, sol_total, tiers, window_end')
      .eq('posted_call', false)
      .lte('window_end', finalizedBefore)
      .order('window_end', { ascending: false })
      .limit(50);

    if (read.error) {
      console.error('[CALLS] post-calls read failed:', read.error.message);
      return { posted: 0 };
    }

    const rows = (read.data ?? []) as CallRow[];
    if (rows.length === 0) return { posted: 0 };

    const eligible = rows.filter((r) => {
      const buyers = typeof r.buyers === 'number' ? r.buyers : 0;
      const sol = typeof r.sol_total === 'number' ? r.sol_total : 0;
      return buyers >= MIN_BUYERS || sTierCount(r.tiers) > 0 || sol >= MIN_SOL;
    });

    let posted = 0;
    for (const row of eligible) {
      if (posted >= MAX_CALLS_PER_RUN) break;
      try {
        const sym = ticker(row.symbol, row.mint);
        const buyers = typeof row.buyers === 'number' ? row.buyers : 0;
        const sCount = sTierCount(row.tiers);
        const sol = fmtSol(row.sol_total);
        const tUrl = tradeUrl(row.mint);
        const tokenPage = `${appBaseUrl()}/token/${row.mint}`;

        const sTag = sCount > 0 ? ` (${sCount} S-tier)` : '';

        const plain =
          `🚨 SMART MONEY APING ${sym} — ${buyers} wallets${sTag} just bought · ${sol}◎\n` +
          `Trade: ${tUrl}\n${tokenPage}`;

        const html =
          `🚨 <b>SMART MONEY APING ${escapeHtml(sym)}</b> — ` +
          `${buyers} wallets${escapeHtml(sTag)} just bought · ${escapeHtml(sol)}◎\n` +
          `<a href="${escapeHtml(tUrl)}">Trade</a> · ` +
          `<a href="${escapeHtml(tokenPage)}">Open</a>`;

        const ok = await broadcast(html, plain);
        if (!ok) {
          // Telegram didn't deliver — don't flip the flag; retry next tick.
          continue;
        }

        const upd = await supabase
          .from('live_bursts')
          .update({ posted_call: true })
          .eq('id', row.id);
        if (upd.error) {
          console.error('[CALLS] mark posted_call failed:', upd.error.message);
          continue;
        }
        posted++;
      } catch (err) {
        console.error('[CALLS] post-call row failed:', (err as Error).message);
      }
    }

    return { posted };
  } catch (err) {
    console.error('[CALLS] post-calls crashed:', (err as Error).message);
    return { posted: 0 };
  }
}

// ---------------------------------------------------------------------------
// POST RESULTS
// ---------------------------------------------------------------------------

/**
 * Find already-called bursts whose measured outcome is notable and not yet
 * result-posted, post each, then flip posted_result=true (only after a
 * successful Telegram send). Capped per run; per-row resilient. Safe no-op when
 * unconfigured.
 */
export async function postResults(): Promise<{ posted: number }> {
  if (!isSupabaseConfigured()) return { posted: 0 };

  try {
    const supabase = getSupabase();

    // Candidates: call already posted, result not yet posted, and at least one
    // measured leg exists. Notability is decided precisely in JS below.
    const read = await supabase
      .from('live_bursts')
      .select('id, mint, symbol, ret_1h, ret_24h, measured_24h_at')
      .eq('posted_call', true)
      .eq('posted_result', false)
      .or('ret_1h.not.is.null,ret_24h.not.is.null')
      .order('window_end', { ascending: false })
      .limit(50);

    if (read.error) {
      console.error('[CALLS] post-results read failed:', read.error.message);
      return { posted: 0 };
    }

    const rows = (read.data ?? []) as ResultRow[];
    if (rows.length === 0) return { posted: 0 };

    let posted = 0;
    for (const row of rows) {
      if (posted >= MAX_RESULTS_PER_RUN) break;
      try {
        const r1 = row.ret_1h;
        const r24 = row.ret_24h;
        const has1 = typeof r1 === 'number' && Number.isFinite(r1);
        const has24 = typeof r24 === 'number' && Number.isFinite(r24);
        const finalized24 = has24 && !!row.measured_24h_at;

        // Notability rule (documented at top of file).
        const win1h = has1 && (r1 as number) >= WIN_RET_1H;
        const bigWin24 = finalized24 && (r24 as number) >= WIN_RET_24H;
        const bigLoss24 = finalized24 && (r24 as number) <= LOSS_RET_24H;
        if (!win1h && !bigWin24 && !bigLoss24) continue;

        const sym = ticker(row.symbol, row.mint);
        const tokenPage = `${appBaseUrl()}/token/${row.mint}`;

        let headline: string;
        let horizon: string;
        let ret: number;
        if (bigWin24 || bigLoss24) {
          ret = r24 as number;
          horizon = '24h ago';
        } else {
          ret = r1 as number;
          horizon = '1h ago';
        }

        const pct = fmtPct(ret);
        if (ret >= 0) {
          headline = `📈 CALLED IT: ${sym} is ${pct} since smart money bought ${horizon}`;
        } else {
          // Honest, instructive loss.
          headline = `📉 OUTCOME: ${sym} is ${pct} since smart money bought ${horizon}`;
        }

        const plain = `${headline}\n${tokenPage}`;
        const html =
          `${ret >= 0 ? '📈 <b>CALLED IT' : '📉 <b>OUTCOME'}</b>: ` +
          `${escapeHtml(sym)} is <b>${escapeHtml(pct)}</b> since smart money bought ${escapeHtml(horizon)}\n` +
          `<a href="${escapeHtml(tokenPage)}">Open</a>`;

        const ok = await broadcast(html, plain);
        if (!ok) continue;

        const upd = await supabase
          .from('live_bursts')
          .update({ posted_result: true })
          .eq('id', row.id);
        if (upd.error) {
          console.error('[CALLS] mark posted_result failed:', upd.error.message);
          continue;
        }
        posted++;
      } catch (err) {
        console.error('[CALLS] post-result row failed:', (err as Error).message);
      }
    }

    return { posted };
  } catch (err) {
    console.error('[CALLS] post-results crashed:', (err as Error).message);
    return { posted: 0 };
  }
}
