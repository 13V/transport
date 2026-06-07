'use client';

/* =========================================================================
   INTERACTIVE PRIMITIVES — client islands (copy, watch, retry).
   Ported from the design prototype's delegated handlers.
   ========================================================================= */
import React, { useState } from 'react';
import Link from 'next/link';
import { Copy, Check, Star, RefreshCw, AlertTriangle } from 'lucide-react';
import { useWatchlist } from '@/lib/useWatchlist';
import * as f from '@/lib/format';
import { tokenLinks, walletLinks } from '@/lib/trade-links';

function stop(e: React.MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Token icon image with a fallback CHAIN: tries each candidate URL in order,
 * advancing on error; when all fail it unmounts and the colored letter avatar
 * shows through. Client-only (needs onError). `key` on the src forces a fresh
 * <img> mount per candidate so onError fires reliably.
 */
export function TokenImg({ srcs, radius }: { srcs: string[]; radius: number }) {
  const [i, setI] = useState(0);
  if (i >= srcs.length) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={srcs[i]}
      src={srcs[i]}
      alt=""
      // Perf: defer offscreen logos, decode off the main thread, and keep these
      // many slow external IPFS/CDN images low-priority so they never compete
      // with critical content or block first paint. A broken/slow gateway just
      // advances to the next candidate via onError — never blocks render.
      loading="lazy"
      decoding="async"
      fetchPriority="low"
      referrerPolicy="no-referrer"
      onError={() => setI((n) => n + 1)}
      // Explicit pixel box (matches the parent TokenMark size via inset:0 +
      // 100%/100%) so the image reserves space and cannot shift layout while it
      // loads or if it never loads at all.
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'cover', borderRadius: radius, display: 'block',
        // Hard floor: even before the % box resolves, the element occupies the
        // fixed avatar square so there is zero cumulative layout shift.
        minWidth: '100%', minHeight: '100%',
      }}
    />
  );
}

export function CopyIconButton({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="iconbtn"
      title={title}
      aria-label={title}
      onClick={(e) => {
        stop(e);
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

export function WatchStar({ address }: { address: string }) {
  const { isWatched, toggle } = useWatchlist();
  const on = isWatched(address);
  return (
    <button
      type="button"
      className={`iconbtn star ${on ? 'on' : ''}`}
      title={on ? 'Remove from watchlist' : 'Watch wallet'}
      aria-label={on ? 'Remove from watchlist' : 'Watch wallet'}
      aria-pressed={on}
      onClick={(e) => { stop(e); toggle(address); }}
    >
      <Star size={14} fill={on ? 'currentColor' : 'none'} />
    </button>
  );
}

interface AddrChipProps {
  address: string;
  copy?: boolean;
  watch?: boolean;
  /** length of leading/trailing chars shown */
  len?: number;
}

export function AddrChip({ address, copy = true, watch = false, len = 4 }: AddrChipProps) {
  return (
    <span className="row gap-8">
      <Link href={`/smart-money/${address}`} className="addr" onClick={(e) => e.stopPropagation()}>
        {f.short(address, len, len)}
      </Link>
      {copy && <CopyIconButton text={address} title="Copy address" />}
      {watch && <WatchStar address={address} />}
    </span>
  );
}

/**
 * Row of quick-trade + explorer chips for a token mint.
 * `primary` promotes a trade-kind link to a larger filled "one-tap ape" button;
 * the rest stay as chips. When `preferred` (a platform label, e.g. 'GMGN') is
 * set and matches a link case-insensitively, that link is promoted; otherwise
 * the FIRST trade-kind link is used. `pairAddress` is forwarded so Photon links
 * to the pool/pair address.
 */
export function TradeLinks({
  mint, size = 'sm', primary = false, preferred, pairAddress,
}: {
  mint: string;
  size?: 'sm' | 'xs';
  primary?: boolean;
  preferred?: string;
  pairAddress?: string;
}) {
  const links = tokenLinks(mint, { pairAddress });
  if (!links.length) return null;

  // Index of the trade link to promote (only when `primary`). Prefer the link
  // matching `preferred` (case-insensitive); fall back to the first trade link.
  let primaryIdx = -1;
  if (primary) {
    if (preferred) {
      const key = preferred.toLowerCase();
      primaryIdx = links.findIndex((l) => l.kind === 'trade' && l.label.toLowerCase() === key);
    }
    if (primaryIdx < 0) primaryIdx = links.findIndex((l) => l.kind === 'trade');
  }

  return (
    <span className="row gap-8 wrap" onClick={(e) => e.stopPropagation()}>
      {links.map((l, i) => {
        if (i === primaryIdx) {
          return (
            <a
              key={l.label}
              className="btn primary sm trade-primary"
              style={{ textDecoration: 'none' }}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Trade on ${l.label} — one tap`}
            >
              Ape · {l.label}
            </a>
          );
        }
        return (
          <a
            key={l.label}
            className={`badge ${l.kind === 'trade' ? 'accent' : 'tag'}`}
            style={{ height: size === 'xs' ? 18 : 21, textDecoration: 'none' }}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open in ${l.label}`}
          >
            {l.label}
          </a>
        );
      })}
    </span>
  );
}

/** Wallet tracking / explorer chips for an address. */
export function WalletLinks({ address }: { address: string }) {
  const links = walletLinks(address);
  if (!links.length) return null;
  return (
    <span className="row gap-8 wrap" onClick={(e) => e.stopPropagation()}>
      {links.map((l) => (
        <a
          key={l.label}
          className={`badge ${l.kind === 'trade' ? 'accent' : 'tag'}`}
          style={{ height: 21, textDecoration: 'none' }}
          href={l.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open in ${l.label}`}
        >
          {l.label}
        </a>
      ))}
    </span>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  msg = 'We couldn’t reach the indexer. This is usually transient.',
  onRetry,
}: {
  title?: string;
  msg?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="placeholder error">
      <div className="ph-ic"><AlertTriangle size={22} /></div>
      <h4>{title}</h4>
      <p>{msg}</p>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          <RefreshCw size={15} /> Retry
        </button>
      )}
    </div>
  );
}
