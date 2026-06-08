/**
 * SHARED WALLET VERIFICATION (non-spoofable, non-custodial)
 *
 * Proves a user controls a Solana wallet by having them SIGN a challenge message
 * with the wallet's private key, then verifying the ed25519 signature against the
 * wallet's public key (the address itself). We never touch private keys or funds
 * — this is sign-only proof of ownership.
 *
 * A verified wallet is persisted to `wallet_verifications` (migration 0016) and
 * can be bound to a Telegram `chat_id` AND/OR a browser `web_session` id, so the
 * one wallet drives every gate:
 *   - Telegram alerts (hold >= TG_GATE_MIN_AMOUNT, default 1,000,000)
 *   - Web premium    (hold >= TOKEN_GATE_MIN_AMOUNT, default 500,000)
 *
 * Verification primitives use `tweetnacl` (ed25519) + `bs58` — both already in
 * the dependency tree. Everything degrades gracefully: when Supabase is
 * unconfigured the bind/lookup helpers are safe no-ops rather than throwing.
 *
 * The challenge message format is fixed so a signature for one product can't be
 * replayed against another:
 *   "Verify wallet for <product> — nonce:<n>"
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';

import { getSupabase, isSupabaseConfigured } from './supabase-client';

/** Solana base58 address charset; 32–44 chars. */
const SOL_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type VerifyProduct = 'web' | 'telegram' | 'api';

/**
 * Build the exact challenge string the wallet must sign. Both the client (sign)
 * and the server (verify) call this so the bytes match exactly.
 */
export function buildChallenge(product: VerifyProduct, nonce: string): string {
  return `Verify wallet for ${product} — nonce:${nonce}`;
}

/**
 * Verify an ed25519 signature over `msg` made by `wallet` (a base58 Solana
 * address == the ed25519 public key). `sig` is base58-encoded (Phantom's
 * signMessage returns raw bytes; the client base58-encodes before sending).
 *
 * Returns true ONLY when the signature is valid for that exact message + key.
 * Never throws — any malformed input yields false (fail closed).
 */
export function verifySignature(wallet: string, msg: string, sig: string): boolean {
  try {
    if (!wallet || !msg || !sig) return false;
    if (!SOL_ADDRESS_RE.test(wallet)) return false;

    const pubKey = bs58.decode(wallet);
    if (pubKey.length !== 32) return false;

    const signature = bs58.decode(sig);
    if (signature.length !== 64) return false;

    const message = new TextEncoder().encode(msg);
    return nacl.sign.detached.verify(message, signature, pubKey);
  } catch {
    return false;
  }
}

export interface BindWalletInput {
  wallet: string;
  chatId?: string | null;
  webSession?: string | null;
}

export interface VerifiedWallet {
  wallet: string;
  chat_id: string | null;
  web_session: string | null;
  verified_at: string | null;
  last_balance: number | null;
  last_checked: string | null;
}

/**
 * Upsert a verified wallet row and bind it to the given chat_id and/or
 * web_session. Caller MUST have already passed verifySignature() — this only
 * persists the binding.
 *
 * Because chat_id / web_session each have a partial UNIQUE index, we first clear
 * any prior wallet that held the same binding (last verify wins) so a binding is
 * always 1:1. Safe no-op (returns false) when Supabase is unconfigured.
 */
export async function bindWallet(input: BindWalletInput): Promise<boolean> {
  const wallet = (input.wallet || '').trim();
  if (!SOL_ADDRESS_RE.test(wallet)) return false;
  if (!isSupabaseConfigured()) return false;

  const chatId = input.chatId ? String(input.chatId).trim() : null;
  const webSession = input.webSession ? String(input.webSession).trim() : null;
  if (!chatId && !webSession) return false;

  try {
    const supabase = getSupabase();

    // Free the binding from any OTHER wallet first, so the partial-unique index
    // on chat_id / web_session never collides (re-binding moves the binding).
    if (chatId) {
      await supabase
        .from('wallet_verifications')
        .update({ chat_id: null })
        .eq('chat_id', chatId)
        .neq('wallet', wallet);
    }
    if (webSession) {
      await supabase
        .from('wallet_verifications')
        .update({ web_session: null })
        .eq('web_session', webSession)
        .neq('wallet', wallet);
    }

    // Read any existing row for this wallet so we preserve the OTHER binding
    // (e.g. binding a web_session shouldn't wipe an existing chat_id).
    const existing = await supabase
      .from('wallet_verifications')
      .select('chat_id, web_session')
      .eq('wallet', wallet)
      .maybeSingle();

    const prevChat = (existing.data as any)?.chat_id ?? null;
    const prevSession = (existing.data as any)?.web_session ?? null;

    const row = {
      wallet,
      chat_id: chatId ?? prevChat,
      web_session: webSession ?? prevSession,
      verified_at: new Date().toISOString(),
    };

    const up = await supabase
      .from('wallet_verifications')
      .upsert(row, { onConflict: 'wallet' });
    if (up.error) {
      console.error('[WALLET-VERIFY] bindWallet upsert failed:', up.error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[WALLET-VERIFY] bindWallet crashed:', (err as Error).message);
    return false;
  }
}

/**
 * Look up the verified wallet bound to a Telegram chat_id OR a web_session.
 * Pass exactly one. Returns null when unbound, unconfigured, or on any error.
 */
export async function getVerifiedWallet(
  by: { chatId?: string | null; webSession?: string | null }
): Promise<VerifiedWallet | null> {
  if (!isSupabaseConfigured()) return null;

  const chatId = by.chatId ? String(by.chatId).trim() : null;
  const webSession = by.webSession ? String(by.webSession).trim() : null;
  if (!chatId && !webSession) return null;

  try {
    const supabase = getSupabase();
    let q = supabase
      .from('wallet_verifications')
      .select('wallet, chat_id, web_session, verified_at, last_balance, last_checked');
    q = chatId ? q.eq('chat_id', chatId) : q.eq('web_session', webSession);

    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    return data as VerifiedWallet;
  } catch {
    return null;
  }
}

/**
 * Best-effort cache of the most recent on-chain balance for a verified wallet.
 * Used by the gates to render "balance dropped" notices without re-reading on
 * every broadcast. Fire-and-forget; never throws.
 */
export async function recordWalletBalance(wallet: string, balance: number): Promise<void> {
  if (!isSupabaseConfigured()) return;
  if (!SOL_ADDRESS_RE.test((wallet || '').trim())) return;
  try {
    const supabase = getSupabase();
    await supabase
      .from('wallet_verifications')
      .update({ last_balance: balance, last_checked: new Date().toISOString() })
      .eq('wallet', wallet.trim());
  } catch {
    /* non-fatal */
  }
}
