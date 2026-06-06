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

function stop(e: React.MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
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
