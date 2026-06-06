/**
 * HELIUS ENHANCED-WEBHOOK SWAP PARSER
 *
 * Helius "enhanced" transaction webhooks POST a JSON ARRAY of enriched
 * transactions. This module turns those into `trades`-table rows for OUR
 * smart wallets, in REAL TIME (sub-second), replacing polling for the
 * subscribed set.
 *
 * Philosophy: NO FAKE DATA. We only emit a row when we can CONFIDENTLY read a
 * SOL <-> token swap for one of our wallets. Anything ambiguous (no clear SOL
 * leg, no clear single token leg, zero/NaN amounts, no identifiable wallet) is
 * SKIPPED rather than guessed.
 *
 * Amount source preference: `events.swap` (most reliable) → fall back to raw
 * `tokenTransfers` + `nativeTransfers`.
 */

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1e9;

/** A row matching the `trades` table (mirrors lib/indexer/run-indexer.ts). */
export interface TradeRow {
  wallet: string;
  token_mint: string;
  trade_type: 'BUY' | 'SELL';
  amount: number;
  price: number;
  sol_amount: number;
  tx_hash: string;
  block_time: string;
  /**
   * DEX venue from the enriched tx (e.g. 'PUMP_FUN','RAYDIUM','JUPITER').
   * Falls back to 'HELIUS' when Helius doesn't tell us. Without this the DB
   * default ('JUPITER') would mislabel every webhook-ingested trade.
   */
  source?: string;
}

// ---- Loose shapes for the Helius enhanced payload (defensive parsing). ----

interface TokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number | string;
}

interface NativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number | string; // lamports
}

interface SwapTokenLeg {
  userAccount?: string;
  mint?: string;
  tokenAmount?: number | string;
  rawTokenAmount?: { tokenAmount?: number | string; decimals?: number };
}

interface SwapNativeLeg {
  account?: string;
  amount?: number | string; // lamports
}

interface SwapEvent {
  nativeInput?: SwapNativeLeg | null;
  nativeOutput?: SwapNativeLeg | null;
  tokenInputs?: SwapTokenLeg[];
  tokenOutputs?: SwapTokenLeg[];
  innerSwaps?: unknown[];
}

interface EnhancedTx {
  signature?: string;
  timestamp?: number; // unix SECONDS
  type?: string;
  source?: string; // DEX venue, e.g. 'PUMP_FUN','RAYDIUM','JUPITER'
  fee?: number; // network + priority fee, lamports
  feePayer?: string;
  tokenTransfers?: TokenTransfer[];
  nativeTransfers?: NativeTransfer[];
  events?: { swap?: SwapEvent | null } | null;
}

/** Finite-number coercion; returns NaN for anything unusable. */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function isSolMint(mint: string | undefined): boolean {
  return !mint || mint === WSOL_MINT;
}

/** Lamports → SOL for a swap native leg / native transfer amount. */
function lamportsToSol(v: unknown): number {
  const n = num(v);
  return Number.isFinite(n) ? n / LAMPORTS_PER_SOL : NaN;
}

/** Pick a token leg's mint+amount, preferring rawTokenAmount when present. */
function legTokenAmount(leg: SwapTokenLeg | undefined): number {
  if (!leg) return NaN;
  const raw = leg.rawTokenAmount;
  if (raw && raw.tokenAmount != null && raw.decimals != null) {
    const amt = num(raw.tokenAmount);
    const dec = num(raw.decimals);
    if (Number.isFinite(amt) && Number.isFinite(dec)) {
      return amt / Math.pow(10, dec);
    }
  }
  return num(leg.tokenAmount);
}

/**
 * Identify the trading wallet for a tx.
 * - With a `subscribed` set: prefer feePayer if it's in the set, else any
 *   account appearing in transfers that's in the set. Returns undefined if
 *   none of our wallets touched the tx.
 * - Without a set: use feePayer.
 */
function pickWallet(tx: EnhancedTx, subscribed?: Set<string>): string | undefined {
  if (!subscribed) {
    return tx.feePayer || undefined;
  }
  if (tx.feePayer && subscribed.has(tx.feePayer)) return tx.feePayer;

  const candidates: (string | undefined)[] = [];
  for (const t of tx.tokenTransfers ?? []) {
    candidates.push(t.fromUserAccount, t.toUserAccount);
  }
  for (const t of tx.nativeTransfers ?? []) {
    candidates.push(t.fromUserAccount, t.toUserAccount);
  }
  for (const c of candidates) {
    if (c && subscribed.has(c)) return c;
  }
  return undefined;
}

/**
 * Try to read the swap from `events.swap` for `wallet` (most reliable).
 * Returns a partial row (no wallet/tx/block_time) or null if not confidently
 * a single SOL<->token swap for this wallet.
 */
function fromSwapEvent(
  swap: SwapEvent,
  wallet: string
): { token_mint: string; trade_type: 'BUY' | 'SELL'; amount: number; sol_amount: number } | null {
  const tokenInputs = swap.tokenInputs ?? [];
  const tokenOutputs = swap.tokenOutputs ?? [];

  // Non-SOL token legs only (WSOL is the SOL side).
  const nonSolInputs = tokenInputs.filter((l) => !isSolMint(l.mint));
  const nonSolOutputs = tokenOutputs.filter((l) => !isSolMint(l.mint));

  const nativeInputSol = swap.nativeInput ? lamportsToSol(swap.nativeInput.amount) : NaN;
  const nativeOutputSol = swap.nativeOutput ? lamportsToSol(swap.nativeOutput.amount) : NaN;

  // WSOL legs count as the SOL side too (some swaps route SOL as wrapped).
  const wsolInputs = tokenInputs.filter((l) => isSolMint(l.mint));
  const wsolOutputs = tokenOutputs.filter((l) => isSolMint(l.mint));
  const sumWsol = (legs: SwapTokenLeg[]) =>
    legs.reduce((s, l) => {
      const a = legTokenAmount(l);
      return Number.isFinite(a) ? s + a : s;
    }, 0);

  // BUY: wallet spent SOL (nativeInput / WSOL in) and received a token (token out).
  if (nonSolOutputs.length === 1 && nonSolInputs.length === 0) {
    const out = nonSolOutputs[0];
    const amount = Math.abs(legTokenAmount(out));
    let sol = Number.isFinite(nativeInputSol) ? nativeInputSol : 0;
    sol += sumWsol(wsolInputs);
    if (out.mint && Number.isFinite(amount) && amount > 0 && sol > 0) {
      return { token_mint: out.mint, trade_type: 'BUY', amount, sol_amount: sol };
    }
  }

  // SELL: wallet sent a token (token in) and received SOL (nativeOutput / WSOL out).
  if (nonSolInputs.length === 1 && nonSolOutputs.length === 0) {
    const inp = nonSolInputs[0];
    const amount = Math.abs(legTokenAmount(inp));
    let sol = Number.isFinite(nativeOutputSol) ? nativeOutputSol : 0;
    sol += sumWsol(wsolOutputs);
    if (inp.mint && Number.isFinite(amount) && amount > 0 && sol > 0) {
      return { token_mint: inp.mint, trade_type: 'SELL', amount, sol_amount: sol };
    }
  }

  return null;
}

/**
 * Fall back to raw tokenTransfers + nativeTransfers attributed to `wallet`.
 * Returns a partial row or null when the SOL<->token swap isn't unambiguous.
 */
function fromTransfers(
  tx: EnhancedTx,
  wallet: string
): { token_mint: string; trade_type: 'BUY' | 'SELL'; amount: number; sol_amount: number } | null {
  // Net token movement per (non-SOL) mint for this wallet.
  const tokenDelta = new Map<string, number>();
  for (const t of tx.tokenTransfers ?? []) {
    if (isSolMint(t.mint) || !t.mint) continue;
    const amt = num(t.tokenAmount);
    if (!Number.isFinite(amt)) continue;
    if (t.toUserAccount === wallet) {
      tokenDelta.set(t.mint, (tokenDelta.get(t.mint) ?? 0) + Math.abs(amt));
    } else if (t.fromUserAccount === wallet) {
      tokenDelta.set(t.mint, (tokenDelta.get(t.mint) ?? 0) - Math.abs(amt));
    }
  }

  // Exactly one non-SOL mint must have a non-zero net movement.
  const moved = [...tokenDelta.entries()].filter(([, d]) => d !== 0);
  if (moved.length !== 1) return null;
  const [mint, delta] = moved[0];

  // Net SOL movement (lamports) for this wallet, incl. WSOL token transfers.
  let lamportsIn = 0;
  let lamportsOut = 0;
  for (const t of tx.nativeTransfers ?? []) {
    const amt = num(t.amount);
    if (!Number.isFinite(amt)) continue;
    if (t.toUserAccount === wallet) lamportsIn += Math.abs(amt);
    else if (t.fromUserAccount === wallet) lamportsOut += Math.abs(amt);
  }
  for (const t of tx.tokenTransfers ?? []) {
    if (!isSolMint(t.mint)) continue;
    const amt = num(t.tokenAmount);
    if (!Number.isFinite(amt)) continue;
    // WSOL tokenTransfers are denominated in SOL units, not lamports.
    const lamports = amt * LAMPORTS_PER_SOL;
    if (t.toUserAccount === wallet) lamportsIn += Math.abs(lamports);
    else if (t.fromUserAccount === wallet) lamportsOut += Math.abs(lamports);
  }
  const solDelta = (lamportsIn - lamportsOut) / LAMPORTS_PER_SOL;

  const amount = Math.abs(delta);
  const sol_amount = Math.abs(solDelta);
  if (!(amount > 0) || !(sol_amount > 0)) return null;

  // token in & SOL out => BUY ; token out & SOL in => SELL.
  if (delta > 0 && solDelta < 0) {
    return { token_mint: mint, trade_type: 'BUY', amount, sol_amount };
  }
  if (delta < 0 && solDelta > 0) {
    return { token_mint: mint, trade_type: 'SELL', amount, sol_amount };
  }
  return null;
}

/**
 * Parse a Helius enhanced-webhook payload into `trades` rows for our wallets.
 *
 * @param payload    The raw POST body (expected: array of enriched txs).
 * @param subscribed Optional set of OUR wallet addresses. When provided, only
 *                   txs touching a wallet in the set are considered. When
 *                   omitted, the feePayer is treated as the trading wallet.
 */
export function parseHeliusSwaps(payload: unknown, subscribed?: Set<string>): TradeRow[] {
  if (!Array.isArray(payload)) return [];

  const rows: TradeRow[] = [];

  for (const raw of payload) {
    // A single bad tx must never abort the batch.
    try {
      const tx = raw as EnhancedTx;
      const signature = tx.signature;
      const timestamp = num(tx.timestamp);
      if (!signature || !Number.isFinite(timestamp) || timestamp <= 0) continue;

      const wallet = pickWallet(tx, subscribed);
      if (!wallet) continue;

      // Prefer events.swap; fall back to raw transfers.
      const swap = tx.events?.swap;
      const parsed =
        (swap ? fromSwapEvent(swap, wallet) : null) ?? fromTransfers(tx, wallet);
      if (!parsed) continue;

      const { token_mint, trade_type, amount } = parsed;
      let { sol_amount } = parsed;
      if (isSolMint(token_mint)) continue; // never store the SOL side as the token

      // Converge on the indexer's price math (swap-fetcher computeWalletDeltas):
      // when the trading wallet is the feePayer, its SOL movement includes the
      // network + priority fee, which is GAS — not trade economics. Add tx.fee
      // back so the same trade prices identically via webhook or indexer.
      if (wallet === tx.feePayer) {
        const feeLamports = num(tx.fee);
        if (Number.isFinite(feeLamports) && feeLamports > 0) {
          sol_amount += feeLamports / LAMPORTS_PER_SOL;
        }
      }

      const price = sol_amount / amount;
      if (!Number.isFinite(price) || price <= 0) continue; // guard div-by-zero / NaN

      // Helius gives the venue; fall back to 'HELIUS' when unknown so the trade
      // isn't silently mislabeled by the DB default.
      const source =
        typeof tx.source === 'string' && tx.source.trim() !== ''
          ? tx.source
          : 'HELIUS';

      rows.push({
        wallet,
        token_mint,
        trade_type,
        amount,
        price,
        sol_amount,
        tx_hash: signature,
        block_time: new Date(timestamp * 1000).toISOString(),
        source,
      });
    } catch {
      // Skip ambiguous / malformed tx — never guess.
      continue;
    }
  }

  return rows;
}
