'use client';

/* =========================================================================
   CopyTradeButton — one-click "Copy" / "Ape" for a mint (NON-CUSTODIAL).

   Strictly non-custodial: this control NEVER signs or sends anything. It only
   builds a prefilled deep link (Axiom / GMGN / Jupiter — carrying our referral
   codes via lib/trade-links.ts) and opens it in a NEW TAB so the user completes
   the swap in THEIR OWN wallet / Phantom. We hold no keys and move no funds.

   Free users: a single "Copy" button that opens the default terminal.
   Premium users (usePremium): quick SOL amount presets (0.1 / 0.5 / 1 / 5,
   persisted via lib/copy-config.ts) and the chosen amount is carried into the
   deep link / wired to their per-source-wallet copy size.

   The custodial auto-copy path (lib/copy-engine.ts) is scaffolded but DISABLED;
   this component intentionally never calls it.
   ========================================================================= */

import { useMemo, useState } from 'react';
import { Copy, ShieldCheck, ChevronDown } from 'lucide-react';
import * as f from '@/lib/format';
import { tokenLinks, type ExtLink } from '@/lib/trade-links';
import { usePremium } from '@/lib/use-premium';
import { useCopyConfig, SOL_PRESETS } from '@/lib/copy-config';

interface CopyTradeButtonProps {
  /** Token mint to copy/ape. */
  mint: string;
  /** Optional source/smart wallet being copied — keys per-wallet copy settings. */
  sourceWallet?: string;
  /** Pool/pair address forwarded so Photon links resolve to the pool. */
  pairAddress?: string;
  /** 'xs' for dense feed rows, 'sm' (default) elsewhere. */
  size?: 'xs' | 'sm';
  /** Preferred terminal label (e.g. 'GMGN'); falls back to the first trade link. */
  preferred?: string;
  /** Compact label ("Copy") vs explicit ("Ape · Copy"). */
  label?: string;
}

/** Append a SOL amount to a deep link using each terminal's known size param.
 *  Conservative: only platforms with a documented/observed amount param get one;
 *  the rest open prefilled-by-token (the user types the size in their wallet). */
function withAmount(link: ExtLink, sol: number): string {
  if (!sol || sol <= 0) return link.url;
  const sep = link.url.includes('?') ? '&' : '?';
  const label = link.label.toLowerCase();
  // GMGN / Jupiter accept an amount-ish query param on their swap UIs; others
  // are best-effort and harmless (ignored params don't break the page).
  if (label === 'jupiter') return `${link.url}${sep}inAmount=${sol}`;
  if (label === 'gmgn') return `${link.url}${sep}buy=${sol}`;
  if (label === 'axiom') return `${link.url}${sep}amount=${sol}`;
  return link.url;
}

export default function CopyTradeButton({
  mint,
  sourceWallet,
  pairAddress,
  size = 'sm',
  preferred,
  label = 'Copy',
}: CopyTradeButtonProps) {
  const { premium } = usePremium();
  const { ready, sizeFor, setWallet, setGlobalDefaultSol, getWallet } = useCopyConfig();
  const [open, setOpen] = useState(false);

  // The trade links (with referral codes baked in by trade-links.ts).
  const links = useMemo(() => tokenLinks(mint, { pairAddress }), [mint, pairAddress]);
  const tradeLinks = useMemo(() => links.filter((l) => l.kind === 'trade'), [links]);

  // Resolve the primary terminal: `preferred` (case-insensitive) → first trade.
  const primary = useMemo<ExtLink | undefined>(() => {
    if (preferred) {
      const key = preferred.toLowerCase();
      const m = tradeLinks.find((l) => l.label.toLowerCase() === key);
      if (m) return m;
    }
    return tradeLinks[0];
  }, [tradeLinks, preferred]);

  if (!mint || !primary) return null;

  // Effective size: persisted per-wallet/global once hydrated, else a safe default.
  const currentSol = ready ? sizeFor(sourceWallet) : 0.5;

  // Persist a newly-chosen preset: per source wallet when known, else global.
  const chooseSize = (sol: number) => {
    if (sourceWallet) {
      const existing = getWallet(sourceWallet);
      setWallet(sourceWallet, { defaultSol: sol, enabled: existing?.enabled ?? true });
    } else {
      setGlobalDefaultSol(sol);
    }
  };

  const href = withAmount(primary, currentSol);
  const reassure = 'Non-custodial — opens your own wallet. We never sign or hold funds.';

  // FREE users (or premium controls collapsed): single deep-link button.
  const apeButton = (
    <a
      className={`btn primary ${size === 'xs' ? 'xs' : 'sm'} trade-primary`}
      style={{ textDecoration: 'none' }}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label} on ${primary.label} — ${reassure}`}
    >
      <Copy size={size === 'xs' ? 12 : 14} />
      {label}
      {premium && currentSol > 0 ? ` ${f.sol(currentSol)}◎` : ''}
    </a>
  );

  // Free users get just the button + a tiny reassurance.
  if (!premium) {
    return (
      <span className="copy-trade" onClick={(e) => e.stopPropagation()}>
        {apeButton}
        <span
          className="copy-trade-nc faint"
          title={reassure}
          style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3 }}
        >
          <ShieldCheck size={10} /> non-custodial
        </span>
      </span>
    );
  }

  // PREMIUM users get presets + the prefilled amount + a terminal note.
  return (
    <span className="copy-trade" onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
      <span className="row gap-8" style={{ alignItems: 'center' }}>
        {apeButton}
        <button
          type="button"
          className={`badge accent ${size === 'xs' ? 'xs' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Choose copy size (SOL)"
          onClick={() => setOpen((o) => !o)}
        >
          {f.sol(currentSol)}◎ <ChevronDown size={11} />
        </button>
      </span>

      {open && (
        <div
          className="card card-pad copy-trade-menu"
          role="menu"
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 40,
            minWidth: 168, display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <div className="row gap-8 wrap" role="group" aria-label="Quick SOL amount">
            {SOL_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                role="menuitemradio"
                aria-checked={currentSol === p}
                className={`badge ${currentSol === p ? 'accent' : 'tag'}`}
                onClick={() => { chooseSize(p); }}
                title={`Copy with ${p} SOL`}
              >
                {p}◎
              </button>
            ))}
          </div>
          <a
            className="btn primary sm trade-primary"
            style={{ textDecoration: 'none', justifyContent: 'center' }}
            href={withAmount(primary, currentSol)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            title={`Open ${primary.label} prefilled with ${f.sol(currentSol)} SOL — ${reassure}`}
          >
            <Copy size={14} /> Copy {f.sol(currentSol)}◎ · {primary.label}
          </a>
          <span className="faint" style={{ fontSize: 10.5, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <ShieldCheck size={11} /> {reassure}
          </span>
        </div>
      )}
    </span>
  );
}
