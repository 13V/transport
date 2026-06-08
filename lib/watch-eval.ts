/**
 * WATCH-RULE EVALUATION
 *
 * Given detected BUY bursts and a user's custom alert rules (watch_rules), work
 * out which rules match which bursts and produce the per-owner notifications to
 * send. Pure + side-effect-free so it's trivially testable; the webhook does the
 * actual dispatch via the existing web-push sender (lib/push.ts).
 *
 * A rule matches a burst when ALL of:
 *   - the rule is not muted;
 *   - burst.buyers >= rule.minBuyers;
 *   - burst.solTotal >= rule.minSol;
 *   - if rule.wallets is non-empty, at least one of those wallets is present in
 *     the burst (burst.wallets); if rule.wallets is empty, any wallet qualifies;
 *   - if rule.holdingOnly is set, at least one of the burst's wallets is in the
 *     owner's `holding` set (the owner's watchlist) — so the rule only fires for
 *     wallets the owner already tracks. When no holding set is supplied for an
 *     owner, holdingOnly rules are treated as matching any wallet (fail-open so a
 *     missing/empty watchlist never silently swallows alerts).
 *
 * Channels: only 'push' is dispatched today. A rule with ONLY 'telegram' (and no
 * 'push') is intentionally NOT returned here — Telegram delivery is owned by a
 * separate agent (lib/alerts/notifier.ts / telegram-bot.ts) and surfaced in the
 * UI as "link in bot". We only emit notifications for the push channel.
 */

export interface EvalBurst {
  mint: string;
  symbol?: string | null;
  /** Distinct smart-money buyers (entities) over the streak. */
  buyers: number;
  /** Cumulative SOL value of the streak. */
  solTotal: number;
  /** Full distinct wallet set in the burst (pre-cluster), for matching. */
  wallets: string[];
}

export interface EvalRule {
  id: string | null;
  owner: string;
  label: string | null;
  wallets: string[];
  minBuyers: number;
  minSol: number;
  holdingOnly: boolean;
  channels: string[];
  muted: boolean;
}

export interface WatchNotification {
  owner: string;
  ruleId: string | null;
  ruleLabel: string | null;
  mint: string;
  symbol: string | null;
  buyers: number;
  solTotal: number;
  /** The matched wallet that triggered the rule (for the notification body). */
  matchedWallet: string | null;
  /** Channels this notification should go to (push only is dispatched today). */
  channels: string[];
}

/** Does this rule want a push? (only 'push' is dispatched here). */
function wantsPush(rule: EvalRule): boolean {
  return rule.channels.includes('push');
}

/**
 * Find the wallet in `burst` that satisfies the rule, or null if none.
 *  - rule.wallets non-empty → must intersect burst.wallets
 *  - rule.holdingOnly       → matched wallet must also be in `holding`
 * Returns the first qualifying wallet (deterministic by burst order).
 */
function matchWallet(
  rule: EvalRule,
  burstWallets: string[],
  holding: Set<string> | undefined
): string | null {
  const wantsSpecific = rule.wallets.length > 0;
  const ruleSet = wantsSpecific ? new Set(rule.wallets) : null;
  // holdingOnly with no holding set supplied → fail-open (treat as no filter)
  // so a missing watchlist never silently swallows the user's alerts.
  const applyHolding = rule.holdingOnly && holding !== undefined && holding.size > 0;

  for (const w of burstWallets) {
    if (ruleSet && !ruleSet.has(w)) continue;
    if (applyHolding && !holding!.has(w)) continue;
    return w;
  }
  // If holdingOnly was requested but we have no usable holding set, still allow a
  // match on the wallet filter alone (fail-open as documented above).
  if (rule.holdingOnly && !applyHolding) {
    if (!ruleSet) return burstWallets[0] ?? null;
    for (const w of burstWallets) if (ruleSet.has(w)) return w;
  }
  return null;
}

/** Does this rule match this burst? Returns the matched wallet or null. */
function evalOne(
  rule: EvalRule,
  burst: EvalBurst,
  holding: Set<string> | undefined
): string | null {
  if (rule.muted) return null;
  if (!wantsPush(rule)) return null;
  if (burst.buyers < rule.minBuyers) return null;
  if (burst.solTotal < rule.minSol) return null;
  return matchWallet(rule, burst.wallets ?? [], holding);
}

/**
 * Evaluate all rules against all bursts and return the push notifications to
 * send. De-duped per (owner, mint, ruleId) so one rule fires once per mint per
 * batch even if multiple of its wallets appear in the same burst. The webhook
 * still applies its own per-(owner, mint) cooldown on top of this.
 *
 * @param bursts    detected BUY bursts from this batch
 * @param rules     all candidate watch rules (typically all rules for owners who
 *                  have any wallet in these bursts, or simply all rules)
 * @param holdings  optional owner -> watched-wallet set, for holdingOnly rules
 */
export function evaluateWatchRules(
  bursts: EvalBurst[],
  rules: EvalRule[],
  holdings?: Map<string, Set<string>>
): WatchNotification[] {
  if (bursts.length === 0 || rules.length === 0) return [];

  const out: WatchNotification[] = [];
  const seen = new Set<string>(); // `${owner}:${mint}:${ruleId}`

  for (const burst of bursts) {
    if (!burst || !burst.mint) continue;
    for (const rule of rules) {
      const matched = evalOne(rule, burst, holdings?.get(rule.owner));
      if (!matched) continue;
      const key = `${rule.owner}:${burst.mint}:${rule.id ?? 'anon'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        owner: rule.owner,
        ruleId: rule.id,
        ruleLabel: rule.label,
        mint: burst.mint,
        symbol: burst.symbol ?? null,
        buyers: burst.buyers,
        solTotal: burst.solTotal,
        matchedWallet: matched,
        channels: rule.channels.filter((c) => c === 'push'),
      });
    }
  }

  return out;
}
