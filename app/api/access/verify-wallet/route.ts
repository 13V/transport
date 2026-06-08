/**
 * VERIFY WALLET — /api/access/verify-wallet
 *
 * The non-spoofable proof-of-ownership endpoint behind the /access page.
 *
 * GET  ?product=&target=&targetKind=  — SERVER-issued challenge. We generate a
 *   cryptographically-random nonce, store a single-use row bound to the EXACT
 *   target (web_session or telegram chat_id) with a short TTL, and return
 *   { ok, nonce, message } where `message` EMBEDS the target + nonce + expiry.
 *
 * POST { wallet, product, nonce, signature, session?, chatId? } — verify. We
 *   look up the issued nonce, require it to EXIST / be UNUSED / UNEXPIRED and
 *   its stored product+target+target_kind to MATCH the body, rebuild the EXACT
 *   signed message from the STORED row (never client input), verify the ed25519
 *   signature against it, mark the nonce single-use, then bind the wallet.
 *
 * This closes FINDING C-1: the nonce is server-issued + single-use and the
 * signed bytes are pinned to the binding target, so a captured signature can't
 * be replayed to bind a victim's wallet to an attacker-chosen session/chat.
 *
 * Non-custodial: the user only SIGNS a message — no funds, no private keys leave
 * the wallet. We persist only the public address + the binding.
 *
 * Resilient: returns { ok:false, reason } on any failure; never throws.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  verifySignature,
  bindWallet,
  issueChallenge,
  consumeNonce,
  markNonceUsed,
  type VerifyProduct,
  type TargetKind,
} from '../../../../lib/wallet-verify';
import { isSupabaseConfigured } from '../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';

const VALID_PRODUCTS: VerifyProduct[] = ['web', 'telegram', 'api'];
const VALID_TARGET_KINDS: TargetKind[] = ['web', 'telegram'];

/** GET — issue a server-side challenge bound to (product, target, targetKind). */
export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'not-configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const product = String(url.searchParams.get('product') || '').trim() as VerifyProduct;
  const target = String(url.searchParams.get('target') || '').trim();
  const targetKind = String(url.searchParams.get('targetKind') || '').trim() as TargetKind;

  if (!VALID_PRODUCTS.includes(product)) {
    return NextResponse.json({ ok: false, reason: 'bad-product' }, { status: 400 });
  }
  if (!VALID_TARGET_KINDS.includes(targetKind)) {
    return NextResponse.json({ ok: false, reason: 'bad-target-kind' }, { status: 400 });
  }
  if (!target) {
    return NextResponse.json({ ok: false, reason: 'missing-target' }, { status: 400 });
  }

  const challenge = await issueChallenge({ product, target, targetKind });
  if (!challenge) {
    return NextResponse.json({ ok: false, reason: 'issue-failed' }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    nonce: challenge.nonce,
    message: challenge.message,
    expiresAtMs: challenge.expiresAtMs,
  });
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'not-configured' }, { status: 503 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad-json' }, { status: 400 });
  }

  const wallet = String(body?.wallet || '').trim();
  const product = String(body?.product || '').trim() as VerifyProduct;
  const nonce = String(body?.nonce || '').trim();
  const signature = String(body?.signature || '').trim();
  const session = body?.session ? String(body.session).trim() : null;
  const chatId = body?.chatId ? String(body.chatId).trim() : null;

  if (!wallet || !nonce || !signature) {
    return NextResponse.json({ ok: false, reason: 'missing-fields' }, { status: 400 });
  }
  if (!VALID_PRODUCTS.includes(product)) {
    return NextResponse.json({ ok: false, reason: 'bad-product' }, { status: 400 });
  }
  if (!session && !chatId) {
    return NextResponse.json({ ok: false, reason: 'no-binding-target' }, { status: 400 });
  }

  // The challenge's binding target is whichever this request carries. The nonce
  // row pins which one it may be; consumeNonce rejects on any mismatch.
  const targetKind: TargetKind = session ? 'web' : 'telegram';
  const target = session ?? (chatId as string);

  // Look up + validate the SERVER-issued nonce and rebuild the signed message
  // from the STORED row (never from client input).
  const consumed = await consumeNonce({ nonce, product, target, targetKind });
  if (!consumed.ok) {
    const status = consumed.reason === 'error' ? 500 : 400;
    return NextResponse.json({ ok: false, reason: `nonce-${consumed.reason}` }, { status });
  }

  // Verify the ed25519 signature against the EXACT stored message.
  if (!verifySignature(wallet, consumed.message, signature)) {
    return NextResponse.json({ ok: false, reason: 'bad-signature' }, { status: 401 });
  }

  // Single-use: flip used=true atomically. If we lost the race, reject.
  const claimed = await markNonceUsed(nonce);
  if (!claimed) {
    return NextResponse.json({ ok: false, reason: 'nonce-used' }, { status: 400 });
  }

  const bound = await bindWallet({ wallet, webSession: session, chatId });
  if (!bound) {
    return NextResponse.json({ ok: false, reason: 'bind-failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, wallet });
}
