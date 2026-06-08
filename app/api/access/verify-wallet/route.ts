/**
 * VERIFY WALLET — POST /api/access/verify-wallet
 *
 * The non-spoofable proof-of-ownership endpoint behind the /access page. The
 * client connects a Solana wallet (Phantom via window.solana), signs our exact
 * challenge message, and POSTs { wallet, product, nonce, signature, session?,
 * chatId? }. We rebuild the challenge, verify the ed25519 signature server-side,
 * and on success bind the wallet to the web_session and/or telegram chat_id.
 *
 * Non-custodial: the user only SIGNS a message — no funds, no private keys leave
 * the wallet. We persist only the public address + the binding.
 *
 * Resilient: returns { ok:false, reason } on any failure; never throws.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  buildChallenge,
  verifySignature,
  bindWallet,
  type VerifyProduct,
} from '../../../../lib/wallet-verify';
import { isSupabaseConfigured } from '../../../../lib/supabase-client';

export const dynamic = 'force-dynamic';

const VALID_PRODUCTS: VerifyProduct[] = ['web', 'telegram', 'api'];

export async function POST(request: NextRequest) {
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

  // Rebuild the EXACT message the client should have signed and verify it.
  const message = buildChallenge(product, nonce);
  if (!verifySignature(wallet, message, signature)) {
    return NextResponse.json({ ok: false, reason: 'bad-signature' }, { status: 401 });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'not-configured' }, { status: 503 });
  }

  const bound = await bindWallet({ wallet, webSession: session, chatId });
  if (!bound) {
    return NextResponse.json({ ok: false, reason: 'bind-failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, wallet });
}
