/**
 * VERIFY API PAYMENT — POST /api/access/verify-payment
 *
 * Body: { signature: string, owner?: string }
 *
 * Verifies an on-chain SOL transfer to OUR treasury landed, then mints a
 * time-boxed API key. Steps (all fail-closed):
 *   1. Look up the transaction by signature via Helius RPC `getTransaction`.
 *   2. Require it succeeded (meta.err == null).
 *   3. Require the net lamport delta INTO TREASURY_WALLET >= API_PRICE_SOL.
 *   4. Require the signature has NOT been redeemed before — we INSERT it into
 *      api_payments (signature PRIMARY KEY), so a replay conflicts and is
 *      rejected. This is the atomic "redeem once" guard.
 *   5. Provision a hashed api_keys row with expires_at = now + API_PERIOD_DAYS
 *      and return the RAW key exactly once.
 *
 * NON-CUSTODIAL: we only VERIFY that funds already moved from the user's wallet
 * to our treasury on-chain. We never hold, escrow, or transfer user funds, and
 * we store only the public signature + address.
 *
 * Honest state: 503 { reason:'not-configured' } when TREASURY_WALLET / Supabase
 * are unset, so the UI can say "monetization not yet configured".
 */

import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

import { initHelius } from '../../../../lib/helius-client';
import { isSupabaseConfigured, getSupabase } from '../../../../lib/supabase-client';
import { provisionApiKey } from '../../../../lib/api-keys';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const LAMPORTS_PER_SOL = 1_000_000_000;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/; // base58 tx signature

function priceSol(): number {
  const v = Number(process.env.API_PRICE_SOL);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function periodDays(): number {
  const v = Number(process.env.API_PERIOD_DAYS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 7;
}

function rpcUrl(): string {
  const key = initHelius();
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

/**
 * The base58 account keys of a transaction, normalized to strings. accountKeys
 * may be strings (jsonParsed/legacy) or objects ({ pubkey }).
 */
function accountKeys(tx: any): string[] {
  const raw: any[] = Array.isArray(tx?.transaction?.message?.accountKeys)
    ? tx.transaction.message.accountKeys
    : [];
  return raw.map((k) => (typeof k === 'string' ? k : k?.pubkey)).filter(Boolean);
}

/**
 * Derive the ACTUAL on-chain payer from the VERIFIED transaction (FINDING M-2:
 * never trust a body-supplied `owner` as the payer). We prefer the account whose
 * lamports decreased the most (the funder of the transfer into treasury); if the
 * balance deltas are unavailable we fall back to the fee-payer signer — index 0
 * of accountKeys, which Solana always defines as the fee-payer / first signer.
 * Returns null when neither can be determined.
 */
function derivePayer(tx: any, treasury: string): string | null {
  const keys = accountKeys(tx);
  if (keys.length === 0) return null;

  const meta = tx?.meta;
  const pre = Array.isArray(meta?.preBalances) ? meta.preBalances : null;
  const post = Array.isArray(meta?.postBalances) ? meta.postBalances : null;

  if (pre && post) {
    let bestIdx = -1;
    let bestDrop = 0;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === treasury) continue; // the recipient, not the payer
      const p = pre[i];
      const q = post[i];
      if (typeof p !== 'number' || typeof q !== 'number') continue;
      const drop = p - q; // positive => this account spent lamports
      if (drop > bestDrop) {
        bestDrop = drop;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) return keys[bestIdx];
  }

  // Fallback: the fee-payer / first signer is always accountKeys[0].
  return keys[0] ?? null;
}

/**
 * Net lamports credited to `treasury` in a transaction = (post - pre) for the
 * treasury's account index. Returns 0 if the account isn't in the tx. We read
 * the raw balances rather than trusting a parsed transfer so any transfer path
 * (system transfer, inner ix, etc.) that nets SOL into the treasury counts.
 */
function lamportsToTreasury(tx: any, treasury: string): number {
  const msg = tx?.transaction?.message;
  const meta = tx?.meta;
  if (!msg || !meta) return 0;

  // accountKeys may be strings (jsonParsed/legacy) or objects ({ pubkey }).
  const rawKeys: any[] = Array.isArray(msg.accountKeys) ? msg.accountKeys : [];
  const keys = rawKeys.map((k) => (typeof k === 'string' ? k : k?.pubkey));
  const idx = keys.indexOf(treasury);
  if (idx < 0) return 0;

  const pre = Array.isArray(meta.preBalances) ? meta.preBalances[idx] : undefined;
  const post = Array.isArray(meta.postBalances) ? meta.postBalances[idx] : undefined;
  if (typeof pre !== 'number' || typeof post !== 'number') return 0;
  return post - pre;
}

export async function POST(request: NextRequest) {
  const treasury = (process.env.TREASURY_WALLET || '').trim();
  if (!treasury || !isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'not-configured' }, { status: 503 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad-json' }, { status: 400 });
  }

  const signature = String(body?.signature || '').trim();
  const owner = body?.owner ? String(body.owner).trim() : null;
  if (!SIG_RE.test(signature)) {
    return NextResponse.json({ ok: false, reason: 'bad-signature-format' }, { status: 400 });
  }

  // 1) Look up the transaction on-chain.
  let tx: any;
  try {
    const res = await axios.post(
      rpcUrl(),
      {
        jsonrpc: '2.0',
        id: '1',
        method: 'getTransaction',
        params: [signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      },
      { timeout: 15000 }
    );
    if (res.data?.error) {
      return NextResponse.json({ ok: false, reason: 'rpc-error' }, { status: 502 });
    }
    tx = res.data?.result;
  } catch {
    return NextResponse.json({ ok: false, reason: 'rpc-unreachable' }, { status: 502 });
  }

  if (!tx) {
    return NextResponse.json({ ok: false, reason: 'tx-not-found' }, { status: 404 });
  }

  // 2) Must have succeeded on-chain.
  if (tx?.meta?.err != null) {
    return NextResponse.json({ ok: false, reason: 'tx-failed' }, { status: 400 });
  }

  // 3) Must have netted >= price into the treasury.
  const credited = lamportsToTreasury(tx, treasury);
  const requiredLamports = Math.floor(priceSol() * LAMPORTS_PER_SOL);
  if (credited < requiredLamports) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'insufficient-amount',
        creditedSol: credited / LAMPORTS_PER_SOL,
        requiredSol: priceSol(),
      },
      { status: 400 }
    );
  }

  // Derive the ACTUAL payer from the verified tx — never trust the body `owner`
  // (FINDING M-2). If a body `owner` was supplied, it MUST equal the derived
  // payer; otherwise reject (attribution forgery) rather than silently trusting.
  const payer = derivePayer(tx, treasury);
  if (!payer) {
    return NextResponse.json({ ok: false, reason: 'payer-underivable' }, { status: 400 });
  }
  if (owner && owner !== payer) {
    return NextResponse.json({ ok: false, reason: 'owner-mismatch' }, { status: 400 });
  }

  // 4) Redeem-once: INSERT the signature (PRIMARY KEY). A replay conflicts.
  const supabase = getSupabase();
  const ins = await supabase.from('api_payments').insert({
    signature,
    payer,
    treasury,
    amount_sol: credited / LAMPORTS_PER_SOL,
    owner_id: payer,
  });
  if (ins.error) {
    // Unique-violation (23505) → already redeemed. Anything else → infra error.
    const code = (ins.error as any).code;
    if (code === '23505') {
      return NextResponse.json({ ok: false, reason: 'already-redeemed' }, { status: 409 });
    }
    console.error('[ACCESS] api_payments insert failed:', ins.error.message);
    return NextResponse.json({ ok: false, reason: 'redeem-failed' }, { status: 500 });
  }

  // 5) Mint the time-boxed key.
  let minted: { rawKey: string; keyHash: string; expiresAt: string };
  try {
    minted = await provisionApiKey({
      tier: 'pro',
      ownerId: payer,
      label: `paid ${priceSol()} SOL / ${periodDays()}d`,
      expiresInDays: periodDays(),
    });
  } catch (err) {
    console.error('[ACCESS] provisionApiKey failed:', (err as Error).message);
    return NextResponse.json({ ok: false, reason: 'mint-failed' }, { status: 500 });
  }

  // Back-link the minted key hash to the payment for auditing (best-effort).
  void supabase
    .from('api_payments')
    .update({ key_hash: minted.keyHash })
    .eq('signature', signature)
    .then(() => undefined, () => undefined);

  return NextResponse.json({
    ok: true,
    apiKey: minted.rawKey,
    expiresAt: minted.expiresAt,
    periodDays: periodDays(),
  });
}
