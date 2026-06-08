/**
 * TELEGRAM BOT WEBHOOK — inbound update handler.
 *
 * Telegram POSTs every update (message / callback_query) here. We parse the
 * command and mutate the caller's telegram_subscriptions row accordingly, then
 * reply in-chat. This is the inbound half of the bot; the fan-out lives in
 * lib/alerts/telegram-bot.ts (broadcastBurst).
 *
 * SECURITY (fail closed): Telegram is told a secret token at setWebhook time and
 * echoes it back in the `X-Telegram-Bot-Api-Secret-Token` header on EVERY
 * request. We require TELEGRAM_WEBHOOK_SECRET to be set and to match that header
 * exactly — otherwise we 401 and do nothing. This is what stops anyone who
 * guesses the URL from driving the bot. The bot token never appears in the URL.
 *
 * RESILIENCE: we ALWAYS return 200 for authenticated updates (even on internal
 * error) so Telegram does not retry-storm us; Telegram only redelivers on a
 * non-2xx. Unauthenticated requests get 401. Env-gated: when the bot token is
 * unset every reply is a no-op (handled in the notifier), and when Supabase is
 * unset we still 200 but can't persist (logged).
 *
 * Commands:
 *   /start                                   register + welcome (the edge/proof)
 *   /filters minbuyers=4 minsol=2 holding=on update alert filters
 *   /watch <wallet>                          add a wallet to watched_wallets
 *   /unwatch <wallet>                        remove a wallet
 *   /mute  /unmute                           pause / resume alerts
 *   /stop                                    delete the subscription
 *   /status                                  show prefs + measured hit-rate
 * Inline button taps (callback_query) are acked (answerCallbackQuery) — the
 * buttons are URL buttons so the tap opens the link client-side; we just ack.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sendToChat } from '../../../../lib/alerts/telegram-bot';
import { tgApi, escapeHtml } from '../../../../lib/alerts/notifier';
import { getSupabase, isSupabaseConfigured } from '../../../../lib/supabase-client';
import { getBurstStats } from '../../../../lib/indexer/burst-outcomes';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Solana base58 address charset; 32–44 chars. Used to validate /watch input so
// we never store junk (and the message can't smuggle anything).
const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_WATCHED = 20;

interface SubRow {
  chat_id: string;
  min_buyers: number | null;
  min_sol: number | null;
  holding_only: boolean | null;
  muted: boolean | null;
  watched_wallets: string[] | null;
}

export async function POST(request: NextRequest) {
  // --- SECURITY: verify the secret-token header, fail closed. ---
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const provided = request.headers.get('x-telegram-bot-api-secret-token');
  if (!secret || provided !== secret) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  let update: any;
  try {
    update = await request.json();
  } catch {
    // Malformed body from an authenticated caller — ack so Telegram won't retry.
    return NextResponse.json({ ok: true });
  }

  try {
    if (update?.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return NextResponse.json({ ok: true });
    }

    const message = update?.message ?? update?.edited_message;
    if (message) {
      await handleMessage(message);
    }
  } catch (err) {
    // Never surface a non-200 to Telegram on our own error — that just triggers
    // a retry storm. Log and ack.
    console.error('[TGBOT] webhook handler error:', (err as Error).message);
  }

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// CALLBACK QUERIES (inline button taps)
// ---------------------------------------------------------------------------

async function handleCallbackQuery(cq: any): Promise<void> {
  // Our inline buttons are URL buttons (the tap opens the trade link directly),
  // so there is no server-side action to take — but Telegram shows a loading
  // spinner on the button until we answer, so ack it to clear the UI.
  const id = cq?.id;
  if (id) {
    await tgApi('answerCallbackQuery', { callback_query_id: String(id) });
  }
}

// ---------------------------------------------------------------------------
// MESSAGES / COMMANDS
// ---------------------------------------------------------------------------

async function handleMessage(message: any): Promise<void> {
  const chatId = message?.chat?.id;
  const text: string = typeof message?.text === 'string' ? message.text : '';
  if (chatId == null) return;
  const chat = String(chatId);

  // Parse "/command@botname arg1 arg2" → command + args.
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    await sendToChat(chat, 'Unknown command. Send /start to see what I can do.');
    return;
  }
  const parts = trimmed.split(/\s+/);
  const command = parts[0].slice(1).split('@')[0].toLowerCase();
  const args = parts.slice(1);

  switch (command) {
    case 'start':
      return cmdStart(chat);
    case 'filters':
      return cmdFilters(chat, args);
    case 'watch':
      return cmdWatch(chat, args, true);
    case 'unwatch':
      return cmdWatch(chat, args, false);
    case 'mute':
      return cmdMute(chat, true);
    case 'unmute':
      return cmdMute(chat, false);
    case 'stop':
      return cmdStop(chat);
    case 'status':
      return cmdStatus(chat);
    case 'verify':
      return cmdVerify(chat);
    default:
      await sendToChat(chat, 'Unknown command. Send /start to see what I can do.');
  }
}

/** Upsert the chat's subscription, returning the row (or null if unconfigured). */
async function ensureSub(chat: string): Promise<SubRow | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabase();
  // Insert-if-absent, then read back the current row.
  const ins = await supabase
    .from('telegram_subscriptions')
    .upsert({ chat_id: chat }, { onConflict: 'chat_id', ignoreDuplicates: true });
  if (ins.error) console.error('[TGBOT] ensureSub upsert failed:', ins.error.message);
  const read = await supabase
    .from('telegram_subscriptions')
    .select('chat_id, min_buyers, min_sol, holding_only, muted, watched_wallets')
    .eq('chat_id', chat)
    .maybeSingle();
  if (read.error) {
    console.error('[TGBOT] ensureSub read failed:', read.error.message);
    return null;
  }
  return (read.data as SubRow) ?? null;
}

async function cmdStart(chat: string): Promise<void> {
  await ensureSub(chat);
  const stats = await getBurstStats(24).catch(() => null);
  const proof =
    stats && stats.n > 0 && stats.hitRate1h != null
      ? `\n\nLast 24h: <b>${stats.burstsToday}</b> bursts, <b>${stats.hitRate1h}%</b> 1h hit-rate across <b>${stats.n}</b> measured calls.`
      : '';

  const html =
    '👋 <b>You\'re in.</b>\n\n' +
    'I DM you the moment multiple <b>smart-money</b> wallets pile into the same token — ' +
    'before it trends. Every alert ships with one-tap <b>Ape</b> buttons (Axiom / GMGN / BullX / Photon / Jupiter) ' +
    'so you act in one click.\n\n' +
    'This isn\'t hype — outcomes are measured from real price history and posted publicly, wins AND losses.' +
    proof +
    '\n\n<b>Commands</b>\n' +
    '/filters minbuyers=4 minsol=2 holding=on — tune your alerts\n' +
    '/watch &lt;wallet&gt; · /unwatch &lt;wallet&gt; — track specific wallets\n' +
    '/mute · /unmute — pause / resume\n' +
    '/verify — link a wallet to unlock gated alerts\n' +
    '/status — your prefs + the measured hit-rate\n' +
    '/stop — unsubscribe';
  await sendToChat(chat, html);
}

async function cmdFilters(chat: string, args: string[]): Promise<void> {
  const sub = await ensureSub(chat);
  if (!isSupabaseConfigured()) {
    await sendToChat(chat, '⚠️ Subscriptions are temporarily unavailable. Try again shortly.');
    return;
  }
  if (args.length === 0) {
    await sendToChat(
      chat,
      'Usage: <code>/filters minbuyers=4 minsol=2 holding=on</code>\nKeys: minbuyers (int), minsol (number), holding (on/off).'
    );
    return;
  }

  const patch: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq < 0) {
      errors.push(a);
      continue;
    }
    const key = a.slice(0, eq).toLowerCase();
    const val = a.slice(eq + 1);
    if (key === 'minbuyers') {
      const n = parseInt(val, 10);
      if (Number.isFinite(n) && n >= 0) patch.min_buyers = n;
      else errors.push(a);
    } else if (key === 'minsol') {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) patch.min_sol = n;
      else errors.push(a);
    } else if (key === 'holding') {
      const on = /^(on|true|yes|1)$/i.test(val);
      const off = /^(off|false|no|0)$/i.test(val);
      if (on) patch.holding_only = true;
      else if (off) patch.holding_only = false;
      else errors.push(a);
    } else {
      errors.push(a);
    }
  }

  if (Object.keys(patch).length === 0) {
    await sendToChat(
      chat,
      'No valid filters found. Usage: <code>/filters minbuyers=4 minsol=2 holding=on</code>'
    );
    return;
  }

  const supabase = getSupabase();
  const upd = await supabase
    .from('telegram_subscriptions')
    .update(patch)
    .eq('chat_id', chat)
    .select('min_buyers, min_sol, holding_only')
    .maybeSingle();
  if (upd.error) {
    console.error('[TGBOT] /filters update failed:', upd.error.message);
    await sendToChat(chat, '⚠️ Could not save your filters. Try again shortly.');
    return;
  }

  const row = (upd.data as Partial<SubRow>) ?? sub ?? {};
  const note = errors.length ? `\n(ignored: ${errors.map((e) => e).join(', ')})` : '';
  await sendToChat(
    chat,
    `✅ Filters updated.\nmin_buyers=<b>${row.min_buyers ?? 0}</b> · min_sol=<b>${row.min_sol ?? 0}</b>◎ · holding_only=<b>${row.holding_only ? 'on' : 'off'}</b>${note}`
  );
}

async function cmdWatch(chat: string, args: string[], add: boolean): Promise<void> {
  await ensureSub(chat);
  if (!isSupabaseConfigured()) {
    await sendToChat(chat, '⚠️ Subscriptions are temporarily unavailable. Try again shortly.');
    return;
  }
  const wallet = (args[0] ?? '').trim();
  if (!SOL_ADDRESS_RE.test(wallet)) {
    await sendToChat(
      chat,
      `Usage: <code>/${add ? 'watch' : 'unwatch'} &lt;wallet&gt;</code> (a Solana address).`
    );
    return;
  }

  const supabase = getSupabase();
  const read = await supabase
    .from('telegram_subscriptions')
    .select('watched_wallets')
    .eq('chat_id', chat)
    .maybeSingle();
  if (read.error) {
    console.error('[TGBOT] /watch read failed:', read.error.message);
    await sendToChat(chat, '⚠️ Could not update your watchlist. Try again shortly.');
    return;
  }

  const current = Array.isArray(read.data?.watched_wallets)
    ? (read.data!.watched_wallets as string[])
    : [];
  const set = new Set(current);
  if (add) {
    if (set.has(wallet)) {
      await sendToChat(chat, 'Already watching that wallet.');
      return;
    }
    if (set.size >= MAX_WATCHED) {
      await sendToChat(chat, `You can watch at most ${MAX_WATCHED} wallets. /unwatch one first.`);
      return;
    }
    set.add(wallet);
  } else {
    if (!set.has(wallet)) {
      await sendToChat(chat, 'That wallet is not on your watchlist.');
      return;
    }
    set.delete(wallet);
  }

  const next = Array.from(set);
  const upd = await supabase
    .from('telegram_subscriptions')
    .update({ watched_wallets: next })
    .eq('chat_id', chat);
  if (upd.error) {
    console.error('[TGBOT] /watch update failed:', upd.error.message);
    await sendToChat(chat, '⚠️ Could not update your watchlist. Try again shortly.');
    return;
  }
  await sendToChat(
    chat,
    add
      ? `✅ Watching <code>${wallet}</code>. You'll get every burst it joins, regardless of filters. (${next.length} watched)`
      : `✅ Removed. (${next.length} watched)`
  );
}

async function cmdMute(chat: string, muted: boolean): Promise<void> {
  await ensureSub(chat);
  if (!isSupabaseConfigured()) {
    await sendToChat(chat, '⚠️ Subscriptions are temporarily unavailable. Try again shortly.');
    return;
  }
  const supabase = getSupabase();
  const upd = await supabase
    .from('telegram_subscriptions')
    .update({ muted })
    .eq('chat_id', chat);
  if (upd.error) {
    console.error('[TGBOT] /mute update failed:', upd.error.message);
    await sendToChat(chat, '⚠️ Could not update. Try again shortly.');
    return;
  }
  await sendToChat(chat, muted ? '🔕 Muted. Send /unmute to resume.' : '🔔 Unmuted. Alerts back on.');
}

async function cmdStop(chat: string): Promise<void> {
  if (!isSupabaseConfigured()) {
    await sendToChat(chat, '⚠️ Subscriptions are temporarily unavailable. Try again shortly.');
    return;
  }
  const supabase = getSupabase();
  const del = await supabase.from('telegram_subscriptions').delete().eq('chat_id', chat);
  if (del.error) {
    console.error('[TGBOT] /stop delete failed:', del.error.message);
    await sendToChat(chat, '⚠️ Could not unsubscribe. Try again shortly.');
    return;
  }
  await sendToChat(chat, '👋 Unsubscribed. Send /start anytime to come back.');
}

/**
 * /verify — reply with a deep link to the web sign page carrying this chat_id.
 *
 * On that page the user connects their Solana wallet (Phantom via window.solana)
 * and SIGNS a challenge message; the server verifies the ed25519 signature and
 * binds the wallet to this chat. Once the verified wallet holds >= the Telegram
 * threshold (TG_GATE_MIN_AMOUNT, default 1M), alerts flow. Non-custodial: the
 * user only signs a message — no funds, no private keys leave their wallet.
 */
async function cmdVerify(chat: string): Promise<void> {
  await ensureSub(chat);
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const url = `${base}/access?chat_id=${encodeURIComponent(chat)}`;
  const html =
    '🔐 <b>Verify your wallet</b>\n\n' +
    'Open the secure page below, connect your Solana wallet, and sign the ' +
    'one-line message (this proves ownership — it never moves funds or touches ' +
    'your keys). Once your wallet holds the required balance, alerts unlock here.\n\n' +
    `<a href="${escapeHtml(url)}">Tap to verify →</a>`;
  await sendToChat(chat, html);
}

async function cmdStatus(chat: string): Promise<void> {
  const sub = await ensureSub(chat);
  const stats = await getBurstStats(24).catch(() => null);

  const watched = Array.isArray(sub?.watched_wallets) ? sub!.watched_wallets!.length : 0;
  const prefs = sub
    ? `min_buyers=<b>${sub.min_buyers ?? 0}</b> · min_sol=<b>${sub.min_sol ?? 0}</b>◎ · ` +
      `holding_only=<b>${sub.holding_only ? 'on' : 'off'}</b> · muted=<b>${sub.muted ? 'yes' : 'no'}</b> · ` +
      `watched=<b>${watched}</b>`
    : '(not subscribed — send /start)';

  const proof =
    stats && stats.n > 0
      ? `\n\n<b>Measured edge (24h)</b>\n` +
        `bursts: <b>${stats.burstsToday}</b> · measured calls: <b>${stats.n}</b>\n` +
        (stats.hitRate1h != null ? `1h hit-rate: <b>${stats.hitRate1h}%</b>\n` : '') +
        (stats.medianRet1h != null ? `1h median: <b>${stats.medianRet1h}%</b>\n` : '') +
        (stats.hitRate24h != null ? `24h hit-rate: <b>${stats.hitRate24h}%</b>` : '')
      : '\n\nNo measured outcomes in the last 24h yet.';

  await sendToChat(chat, `<b>Your settings</b>\n${prefs}${proof}`);
}
