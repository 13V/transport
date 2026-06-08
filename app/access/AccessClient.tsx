'use client';

/**
 * ACCESS CLIENT — connect wallet, sign-to-verify (non-custodial), and the three
 * gate flows. The server is the source of truth for every verdict; this is just
 * the UI + the wallet-signing client.
 *
 * NON-CUSTODIAL: the only wallet interaction is signMessage() — the user signs a
 * one-line challenge to prove ownership. No funds, no approvals, no key access.
 * The API flow pays SOL DIRECTLY to our treasury on-chain; we only verify it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@/lib/gating/useWallet';
import { usePremium, getWebSession } from '@/lib/use-premium';

// --- Minimal base58 encoder (Bitcoin alphabet) so we can encode the raw
// signature bytes for the server without pulling a browser Buffer polyfill. ---
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let k = 0; bytes[k] === 0 && k < bytes.length - 1; k++) out += '1';
  for (let q = digits.length - 1; q >= 0; q--) out += B58_ALPHABET[digits[q]];
  return out;
}

interface SolanaProvider {
  signMessage?: (msg: Uint8Array, enc?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
}
function provider(): SolanaProvider | null {
  if (typeof window === 'undefined') return null;
  return (window as any).solana ?? null;
}

interface PayInfo {
  configured: boolean;
  treasury?: string;
  priceSol?: number;
  periodDays?: number;
  reference?: string;
  instructions?: string;
}

export default function AccessClient() {
  const { address, connect, disconnect, connecting, hasProvider } = useWallet();
  const premium = usePremium();

  const [chatId, setChatId] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);

  const [pay, setPay] = useState<PayInfo | null>(null);
  const [sig, setSig] = useState('');
  const [payMsg, setPayMsg] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [verifyingPay, setVerifyingPay] = useState(false);

  // Pick up a chat_id deep-linked from the Telegram /verify command.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search).get('chat_id');
    if (p) setChatId(p.trim());
  }, []);

  // Load the API payment instructions (treasury + price + reference).
  useEffect(() => {
    fetch('/api/access/pay', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setPay(d))
      .catch(() => setPay({ configured: false }));
  }, []);

  const handleVerify = useCallback(
    async (product: 'web' | 'telegram') => {
      const prov = provider();
      if (!address || !prov?.signMessage) {
        setVerifyMsg('Connect a wallet that supports message signing first.');
        return;
      }
      setSigning(true);
      setVerifyMsg(null);
      try {
        const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const message = `Verify wallet for ${product} — nonce:${nonce}`;
        const encoded = new TextEncoder().encode(message);
        const res: any = await prov.signMessage(encoded, 'utf8');
        const sigBytes: Uint8Array = res?.signature ?? res;
        const signature = base58encode(sigBytes);

        const body: Record<string, unknown> = {
          wallet: address,
          product,
          nonce,
          signature,
        };
        if (product === 'web') body.session = getWebSession();
        if (product === 'telegram') body.chatId = chatId;

        const resp = await fetch('/api/access/verify-wallet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (data?.ok) {
          setVerifyMsg(
            product === 'web'
              ? 'Wallet verified for web premium. Status updates below.'
              : 'Wallet verified and linked to your Telegram chat.'
          );
          if (product === 'web') premium.refresh();
        } else {
          setVerifyMsg(`Verification failed: ${data?.reason ?? 'unknown error'}.`);
        }
      } catch (err) {
        setVerifyMsg(`Signing cancelled or failed: ${(err as Error).message}`);
      } finally {
        setSigning(false);
      }
    },
    [address, chatId, premium]
  );

  const handleVerifyPayment = useCallback(async () => {
    if (!sig.trim()) {
      setPayMsg('Paste your transaction signature first.');
      return;
    }
    setVerifyingPay(true);
    setPayMsg(null);
    setApiKey(null);
    try {
      const resp = await fetch('/api/access/verify-payment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signature: sig.trim(), owner: address ?? null }),
      });
      const data = await resp.json();
      if (data?.ok && data.apiKey) {
        setApiKey(data.apiKey);
        setPayMsg(`Key minted. Expires ${new Date(data.expiresAt).toLocaleString()}.`);
      } else {
        setPayMsg(`Could not verify payment: ${data?.reason ?? 'unknown error'}.`);
      }
    } catch (err) {
      setPayMsg(`Verify failed: ${(err as Error).message}`);
    } finally {
      setVerifyingPay(false);
    }
  }, [sig, address]);

  const copy = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* ignore */
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '2rem 1.25rem', lineHeight: 1.5 }}>
      <h1 style={{ fontSize: '1.6rem', marginBottom: '0.25rem' }}>Access &amp; Membership</h1>
      <p style={{ color: '#888', marginTop: 0 }}>
        Connect your Solana wallet and sign a one-line message to prove ownership.
        This is <strong>non-custodial</strong> — signing never moves funds or
        exposes your keys.
      </p>

      {/* WALLET CONNECT */}
      <section style={card}>
        <h2 style={h2}>1 · Connect wallet</h2>
        {!hasProvider && (
          <p style={muted}>
            No Solana wallet detected. Install Phantom (or another{' '}
            <code>window.solana</code> wallet) and reload.
          </p>
        )}
        {address ? (
          <div>
            <p style={{ margin: '0 0 0.5rem' }}>
              Connected: <code>{address}</code>
            </p>
            <button style={btnGhost} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        ) : (
          <button style={btn} onClick={() => void connect()} disabled={connecting || !hasProvider}>
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
        )}
      </section>

      {/* WEB PREMIUM */}
      <section style={card}>
        <h2 style={h2}>2 · Web premium (hold the gate token)</h2>
        {!premium.configured ? (
          <p style={muted}>Monetization not yet configured. Web access is fully open for now.</p>
        ) : (
          <>
            <p style={{ margin: '0 0 0.5rem' }}>
              Status:{' '}
              <strong style={{ color: premium.premium ? '#2ec27e' : '#e0a13a' }}>
                {premium.loading ? 'checking…' : premium.premium ? 'PREMIUM' : 'not premium'}
              </strong>
              {premium.required != null && (
                <span style={muted}>
                  {' '}
                  · need {premium.required.toLocaleString()}
                  {premium.balance != null ? ` · holding ${premium.balance.toLocaleString()}` : ''}
                </span>
              )}
            </p>
            <button
              style={btn}
              onClick={() => void handleVerify('web')}
              disabled={!address || signing}
            >
              {signing ? 'Signing…' : 'Verify wallet for web premium'}
            </button>
          </>
        )}
      </section>

      {/* TELEGRAM */}
      <section style={card}>
        <h2 style={h2}>3 · Telegram alerts (hold the gate token)</h2>
        {chatId ? (
          <p style={muted}>
            Linking to Telegram chat <code>{chatId}</code>.
          </p>
        ) : (
          <p style={muted}>
            Open the bot and send <code>/verify</code> — it will deep-link you back
            here with your chat attached. You can still verify your wallet now; the
            link completes once you arrive from Telegram.
          </p>
        )}
        <button
          style={btn}
          onClick={() => void handleVerify('telegram')}
          disabled={!address || signing || !chatId}
        >
          {signing ? 'Signing…' : 'Verify & link Telegram'}
        </button>
      </section>

      {/* API PAYMENT */}
      <section style={card}>
        <h2 style={h2}>4 · API access (pay per period)</h2>
        {!pay?.configured ? (
          <p style={muted}>Monetization not yet configured. API payments are unavailable.</p>
        ) : (
          <>
            <p style={{ margin: '0 0 0.5rem' }}>
              Send <strong>{pay.priceSol} SOL</strong> to the treasury below
              (memo = the reference), then paste your transaction signature to mint
              a key valid for <strong>{pay.periodDays} days</strong>. Funds go
              straight to our treasury on-chain — we never hold them.
            </p>
            <div style={kv}>
              <span style={muted}>Treasury</span>
              <code style={mono}>{pay.treasury}</code>
              <button style={btnTiny} onClick={() => copy(pay.treasury!)}>
                copy
              </button>
            </div>
            <div style={kv}>
              <span style={muted}>Reference (memo)</span>
              <code style={mono}>{pay.reference}</code>
              <button style={btnTiny} onClick={() => copy(pay.reference!)}>
                copy
              </button>
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <input
                style={input}
                placeholder="Transaction signature"
                value={sig}
                onChange={(e) => setSig(e.target.value)}
              />
              <button style={btn} onClick={() => void handleVerifyPayment()} disabled={verifyingPay}>
                {verifyingPay ? 'Verifying…' : "I've paid — verify"}
              </button>
            </div>
            {apiKey && (
              <div style={{ marginTop: '0.75rem' }}>
                <p style={muted}>Your API key (shown once — copy it now):</p>
                <code style={{ ...mono, wordBreak: 'break-all' }}>{apiKey}</code>
                <button style={btnTiny} onClick={() => copy(apiKey)}>
                  copy
                </button>
              </div>
            )}
            {payMsg && <p style={{ ...muted, marginTop: '0.5rem' }}>{payMsg}</p>}
          </>
        )}
      </section>

      {verifyMsg && <p style={{ ...muted, marginTop: '1rem' }}>{verifyMsg}</p>}
    </main>
  );
}

// --- inline styles (no design-system dependency; keeps this self-contained) ---
const card: React.CSSProperties = {
  border: '1px solid #2a2a2a',
  borderRadius: 12,
  padding: '1rem 1.25rem',
  marginTop: '1rem',
};
const h2: React.CSSProperties = { fontSize: '1.05rem', margin: '0 0 0.75rem' };
const muted: React.CSSProperties = { color: '#888', fontSize: '0.9rem' };
const mono: React.CSSProperties = { fontFamily: 'monospace', fontSize: '0.85rem' };
const kv: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flexWrap: 'wrap',
  marginTop: '0.4rem',
};
const btn: React.CSSProperties = {
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '0.5rem 0.9rem',
  cursor: 'pointer',
  fontSize: '0.9rem',
};
const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #3a3a3a',
  borderRadius: 8,
  padding: '0.4rem 0.8rem',
  cursor: 'pointer',
  fontSize: '0.85rem',
};
const btnTiny: React.CSSProperties = {
  background: 'transparent',
  color: '#3b82f6',
  border: '1px solid #2a2a2a',
  borderRadius: 6,
  padding: '0.2rem 0.5rem',
  cursor: 'pointer',
  fontSize: '0.75rem',
};
const input: React.CSSProperties = {
  background: '#111',
  color: '#eee',
  border: '1px solid #2a2a2a',
  borderRadius: 8,
  padding: '0.5rem 0.7rem',
  fontSize: '0.85rem',
  width: '100%',
  marginBottom: '0.5rem',
  fontFamily: 'monospace',
};
