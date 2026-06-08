/* =========================================================================
   COPY ENGINE — CUSTODIAL AUTO-EXEC SCAFFOLD (DISABLED BY DEFAULT)
   =========================================================================

   ⚠️  THIS IS A SCAFFOLD, NOT A WORKING EXECUTOR.  ⚠️

   Both exported functions THROW `not-enabled` unless the server env flag
   `COPY_AUTOEXEC_ENABLED === 'true'` (default: off). There is NO signing, NO
   private-key handling, NO transaction submission anywhere in this file — only
   the interface and the guardrails that any real implementation MUST satisfy.

   The shipping product is strictly NON-CUSTODIAL: the user clicks Copy/Ape and
   we deep-link THEIR OWN wallet (Phantom / Axiom / GMGN / Jupiter) prefilled
   with the chosen size. We never touch funds. This file exists so the custodial
   "auto-copy without a click" path has a documented, type-checked shape to grow
   into — behind a flag that is OFF — without anyone wiring it up by accident.

   -------------------------------------------------------------------------
   WHAT REAL AUTO-EXEC REQUIRES BEFORE THIS FLAG CAN BE SAFELY TURNED ON
   -------------------------------------------------------------------------
   Do NOT set COPY_AUTOEXEC_ENABLED=true until ALL of the following exist,
   are tested, and have been reviewed:

   1. DELEGATED SIGNING — never custody raw private keys.
        - Either session keys / delegated-authority scoped to a spend limit and
          expiry (user signs a one-time delegation), OR a relayer/AA wallet the
          user funds and authorizes. Keys live in an HSM/KMS, never in app code,
          env, logs, or the database.
   2. SLIPPAGE & RISK CAPS — per-trade max slippage, min liquidity, honeypot /
        mint-authority / freeze-authority checks BEFORE every buy; reject when
        the same rug filters the UI shows would flag the token.
   3. PER-USER SPEND LIMITS — hard daily + per-trade ceilings enforced
        server-side (the client `maxPerTradeSol` in copy-config.ts is advisory
        only and MUST NOT be trusted as the limit). Idempotency keys so a
        retried webhook can't double-spend.
   4. MEV & PRIORITY-FEE HANDLING — priority fee strategy, optional Jito/private
        relay or other sandwich protection, compute-budget tuning, and a
        deterministic retry/timeout policy for dropped transactions.
   5. AUDIT TRAIL — append-only record of every planned + executed trade
        (intent, quote, signature, fill, fees, source-wallet trigger) for the
        user and for dispute resolution.
   6. LEGAL / CUSTODY / COMPLIANCE REVIEW — executing trades on a user's behalf
        with delegated authority likely triggers money-transmission / custody
        and securities considerations. Requires explicit, revocable per-user
        opt-in consent, ToS, and sign-off from legal before enabling in ANY
        jurisdiction.

   Until every item above is satisfied, the only correct value is OFF.
   ========================================================================= */

import { resolveCopySize, type CopyConfig } from './copy-config';

/** Server-side flag. Auto-exec is OFF unless explicitly set to the string
 *  'true'. Read lazily so tests / runtime toggles see the current value. */
export function isAutoExecEnabled(): boolean {
  return process.env.COPY_AUTOEXEC_ENABLED === 'true';
}

/** Thrown by every engine entry point while the feature is disabled. The
 *  string code `not-enabled` is part of the contract — callers branch on it. */
export class CopyEngineDisabledError extends Error {
  readonly code = 'not-enabled';
  constructor(msg = 'Custodial copy auto-exec is not enabled (COPY_AUTOEXEC_ENABLED!=="true").') {
    super(msg);
    this.name = 'CopyEngineDisabledError';
  }
}

/** A request to copy a source wallet's buy of `mint` for `userId`. */
export interface CopyTradeRequest {
  /** Internal user id (NOT a wallet) the copy is for. */
  userId: string;
  /** Token mint to buy. */
  mint: string;
  /** Source/smart wallet whose buy triggered this copy (the wallet to copy). */
  sourceWallet: string;
  /** The user's persisted copy settings (drives size + caps). */
  config: CopyConfig;
  /** Optional explicit size override (SOL); falls back to resolveCopySize. */
  sizeSolOverride?: number | null;
}

/** A validated, ready-to-execute plan. Pure data — no side effects, no signing.
 *  Produced by `planCopyTrade`; consumed by `executeCopyTrade`. */
export interface CopyTradePlan {
  userId: string;
  mint: string;
  sourceWallet: string;
  /** Resolved buy size in SOL (after applying per-wallet defaults + caps). */
  sizeSol: number;
  /** Max slippage in basis points the executor must not exceed. */
  maxSlippageBps: number;
  /** Wall-clock the plan was built (ms) — plans should be short-lived. */
  createdAt: number;
  /** Idempotency key so a replayed trigger cannot double-execute. */
  idempotencyKey: string;
}

/** Outcome of an execution attempt. The DISABLED engine never returns this. */
export interface CopyTradeResult {
  status: 'executed' | 'skipped' | 'failed';
  /** Transaction signature when executed. */
  signature?: string;
  /** Filled size in SOL. */
  filledSol?: number;
  /** Human-readable reason for skipped/failed. */
  reason?: string;
}

/** Default slippage ceiling for a hypothetical plan (1.5%). */
const DEFAULT_MAX_SLIPPAGE_BPS = 150;

/**
 * Build (but do NOT execute) a copy-trade plan from a request. Pure validation +
 * size resolution; performs no network or signing work and holds no secrets.
 *
 * THROWS {@link CopyEngineDisabledError} (`code: 'not-enabled'`) unless
 * `COPY_AUTOEXEC_ENABLED === 'true'`. This keeps even plan-building gated so no
 * custodial code path runs while the feature is off.
 */
export function planCopyTrade(req: CopyTradeRequest): CopyTradePlan {
  if (!isAutoExecEnabled()) throw new CopyEngineDisabledError();

  // --- The block below only runs when the flag is ON. It is intentionally
  //     minimal: it resolves a size + caps but still performs NO signing. A real
  //     implementation must add the rug/slippage/liquidity checks listed in the
  //     header before returning a plan. ---
  if (!req.userId || !req.mint || !req.sourceWallet) {
    throw new Error('planCopyTrade: userId, mint and sourceWallet are required.');
  }
  const resolved = resolveCopySize(req.config, req.sourceWallet);
  const sizeSol = req.sizeSolOverride != null && req.sizeSolOverride > 0
    ? Math.min(req.sizeSolOverride, resolved)
    : resolved;

  return {
    userId: req.userId,
    mint: req.mint,
    sourceWallet: req.sourceWallet,
    sizeSol,
    maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS,
    createdAt: Date.now(),
    idempotencyKey: `${req.userId}:${req.mint}:${req.sourceWallet}:${Date.now()}`,
  };
}

/**
 * Execute a previously-built plan. In this scaffold it ALWAYS throws — there is
 * deliberately no signing, no key access and no transaction submission here.
 *
 * THROWS {@link CopyEngineDisabledError} (`code: 'not-enabled'`) while disabled.
 * When the flag is ON it STILL throws `not-implemented`, because real execution
 * requires the delegated-signing / relayer / risk / audit machinery documented
 * in the file header — none of which is implemented. Do not add signing logic
 * here without completing that checklist and a security + legal review.
 */
export async function executeCopyTrade(_plan: CopyTradePlan): Promise<CopyTradeResult> {
  if (!isAutoExecEnabled()) throw new CopyEngineDisabledError();
  // Flag is on but the safe machinery does not exist yet — refuse to "execute".
  throw new Error(
    'executeCopyTrade: not-implemented — custodial execution (delegated signing, ' +
    'slippage/risk caps, spend limits, MEV handling, audit + legal review) is not built. ' +
    'See the checklist at the top of lib/copy-engine.ts.'
  );
}
