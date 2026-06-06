# Token Gating (Phase 0)

Wallet-connect + on-chain token-balance-gated **Pro** access.

This is **scaffolding**. It is **fully disabled by default** and stays a complete
no-op until the project token launches and the feature flag is flipped via env.
With gating off, production looks and behaves exactly as it does today: the
wallet UI never mounts, no wallet hooks run, and every `useGate()` consumer is
treated as Pro (everything unlocked).

## The env contract (3 vars)

All three are `NEXT_PUBLIC_*` so the same values are readable on both the server
and the client. They are read in `lib/gating/config.ts`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_GATING_ENABLED` | `false` | Master switch. `true` (or `1`) turns gating ON. |
| `NEXT_PUBLIC_GATE_TOKEN_MINT` | _(empty)_ | The project token's mint address. Empty until launch. |
| `NEXT_PUBLIC_GATE_MIN_BALANCE` | `0` | Minimum UI-amount balance of the gate token required for Pro. |

### The safety rule

Gating is considered live **only when BOTH** of these are true:

1. `NEXT_PUBLIC_GATING_ENABLED` is enabled, **and**
2. `NEXT_PUBLIC_GATE_TOKEN_MINT` is a non-empty string.

`isGatingEnabled()` enforces this. Flipping the flag without setting a real mint
keeps gating OFF rather than locking everyone out against an empty/meaningless
mint. So a half-configured env can never break production.

## How to turn it on at launch

1. Set all three env vars (e.g. in Vercel project settings or `.env.local`):

   ```bash
   NEXT_PUBLIC_GATING_ENABLED=true
   NEXT_PUBLIC_GATE_TOKEN_MINT=<your_token_mint_address>
   NEXT_PUBLIC_GATE_MIN_BALANCE=1000   # whatever Pro threshold you want
   ```

2. Re-build / re-deploy. `NEXT_PUBLIC_*` values are inlined at build time, so a
   new build is required for the change to take effect.

3. Verify: the topbar now shows a **Connect wallet** button. After connecting a
   wallet that holds at least `NEXT_PUBLIC_GATE_MIN_BALANCE` of the mint, a
   **Pro** badge appears.

## How to turn it back off

Set `NEXT_PUBLIC_GATING_ENABLED=false` (or clear `NEXT_PUBLIC_GATE_TOKEN_MINT`)
and re-deploy. Everything reverts to the fully-unlocked state.

## How it works (files)

- `lib/gating/config.ts` — reads the 3 env vars; exports the typed
  `gatingConfig` object and the `isGatingEnabled()` helper.
- `lib/gating/balance.ts` — server-safe on-chain reader. Given a wallet, fetches
  its real UI-amount balance of the gate token via `getTokenAccountsByOwner`
  (reusing the app's Helius/RPC plumbing). Returns `0` on any error — never
  fake data, never throws.
- `lib/gating/useWallet.ts` (`'use client'`) — connects to the standard injected
  Solana provider (`window.solana`: Phantom / Solflare / Backpack). **No
  `@solana/wallet-adapter` dependency.** Persists the connected address to
  `localStorage` so it survives reload. Fully SSR-guarded.
- `lib/gating/useGate.ts` (`'use client'`) — the one hook the UI consumes.
  Combines `useWallet` with a server balance check to expose
  `{ connected, address, isPro, balance, loading, ... }`. When gating is
  disabled it **always returns `isPro: true`** and makes no network calls.
- `app/api/gate/balance/route.ts` — `GET /api/gate/balance?address=<wallet>`.
  Server-side balance verdict (keeps the RPC key on the server). Returns
  `{ isPro: true }` passthrough when gating is disabled.
- `components/GateControls.tsx` (`'use client'`) — the topbar wallet chip + Pro
  badge. Only mounted when gating is enabled.
- `components/AppShell.tsx` — renders `<GateControls />` only behind
  `isGatingEnabled()`. No visual change when the flag is off.

## No new dependencies

This feature adds **zero** npm dependencies. Wallet connection uses the injected
provider directly; on-chain reads reuse the existing `axios` + Helius/RPC setup.
