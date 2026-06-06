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
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setI((n) => n + 1)}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        objectFit: 'cover', borderRadius: radius, display: 'block',
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

/** Row of quick-trade + explorer chips for a token mint. */
export function TradeLinks({ mint, size = 'sm' }: { mint: string; size?: 'sm' | 'xs' }) {
  const links = tokenLinks(mint);
  if (!links.length) return null;
  return (
    <span className="row gap-8 wrap" onClick={(e) => e.stopPropagation()}>
      {links.map((l) => (
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
      ))}
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
