'use client';

/* =========================================================================
   APP SHELL — left sidebar + slim topbar (terminal layout).
   Ported from the design prototype (app.js + theme.css shell).
   ========================================================================= */
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity, LayoutDashboard, Crown, Flame, Radio, Star, BookOpen, Search,
} from 'lucide-react';
import * as f from '@/lib/format';
import { isGatingEnabled } from '@/lib/gating/config';
import GateControls from '@/components/GateControls';

interface NavItem { href: string; label: string; icon: React.ComponentType<{ size?: number }>; owner: string; }
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Analytics', items: [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard, owner: 'dashboard' },
    { href: '/smart-money', label: 'Leaderboard', icon: Crown, owner: 'leaderboard' },
    { href: '/smart-money/buying', label: 'Buying', icon: Flame, owner: 'buying' },
    { href: '/live', label: 'Live', icon: Radio, owner: 'live' },
  ] },
  { group: 'You', items: [
    { href: '/watchlist', label: 'Watchlist', icon: Star, owner: 'watchlist' },
  ] },
  { group: 'Developer', items: [
    { href: '/docs', label: 'API', icon: BookOpen, owner: 'docs' },
  ] },
];

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// A real Solana pubkey (wallet OR mint) is 32 bytes → 43–44 base58 chars.
// Anything shorter that still matches B58 is almost never a live address.
const PUBKEY_LEN_MIN = 43;

// Freshness palette for the network dot. We only ever colour it from the REAL
// last-index time returned by /api/status — never a hardcoded "live" green.
const FRESH_MS = 15 * 60 * 1000;   // < 15m  → healthy (green)
const STALE_MS = 60 * 60 * 1000;   // < 60m  → lagging (amber), else stale (red)
const DOT_GREEN = '#34D399';       // var(--pos)
const DOT_AMBER = '#E2B86B';       // matches code-accent amber in globals.css
const DOT_RED = '#FB7185';         // var(--neg)
const DOT_GREY = '#4C5366';        // var(--text-4) — unknown / status unavailable

type Freshness = { color: string; live: boolean };
function freshnessFor(lastRunMs: number | null): Freshness {
  if (lastRunMs == null) return { color: DOT_GREY, live: false };
  const age = Date.now() - lastRunMs;
  if (age < FRESH_MS) return { color: DOT_GREEN, live: true };
  if (age < STALE_MS) return { color: DOT_AMBER, live: false };
  return { color: DOT_RED, live: false };
}

function ownerFor(path: string): string {
  if (path === '/') return 'dashboard';
  if (path.startsWith('/smart-money/buying')) return 'buying';
  if (path.startsWith('/smart-money')) return 'leaderboard';
  if (path.startsWith('/token')) return 'buying';
  if (path.startsWith('/watchlist')) return 'watchlist';
  if (path.startsWith('/docs')) return 'docs';
  if (path.startsWith('/live')) return 'live';
  return 'dashboard';
}

function titleFor(path: string): string {
  if (path === '/') return 'Dashboard';
  if (path.startsWith('/smart-money/buying')) return 'Buying';
  if (path.startsWith('/smart-money/')) {
    const seg = path.split('/')[2] || '';
    return seg ? `Wallet · ${f.short(seg, 4, 4)}` : 'Wallet';
  }
  if (path.startsWith('/smart-money')) return 'Leaderboard';
  if (path.startsWith('/token/')) {
    const seg = path.split('/')[2] || '';
    return seg ? `Token · ${f.short(seg, 4, 4)}` : 'Token';
  }
  if (path.startsWith('/watchlist')) return 'Watchlist';
  if (path.startsWith('/docs')) return 'API Reference';
  if (path.startsWith('/live')) return 'Live';
  return 'Smart Money';
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const router = useRouter();
  const owner = ownerFor(pathname);
  const searchRef = useRef<HTMLInputElement>(null);
  // Real indexer freshness, sourced from /api/status (field: lastIndexRun.at).
  // null = not yet loaded / unavailable → neutral grey dot, never a fake "live".
  const [lastIndexMs, setLastIndexMs] = useState<number | null>(null);
  const [statusReady, setStatusReady] = useState(false);

  // Poll real indexer freshness: once on mount + a light 60s refresh.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = await res.json();
        // lastIndexRun is the bookkeeping record { at: ISO, ... } from the
        // indexer; .at is the wall-clock time of the last successful run.
        const at = json?.lastIndexRun?.at;
        const ms = at ? Date.parse(at) : NaN;
        if (alive) {
          setLastIndexMs(Number.isFinite(ms) ? ms : null);
          setStatusReady(true);
        }
      } catch {
        if (alive) { setLastIndexMs(null); setStatusReady(true); }
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const fresh = freshnessFor(lastIndexMs);

  // When THIS view was loaded. The topbar "Updated" reflects the freshness of
  // what you're looking at (every page fetches on mount, and token market data
  // is live), so it resets on each navigation — distinct from the indexer's own
  // last-run age, which the dot colour + tooltip still surface honestly.
  const [loadedAt, setLoadedAt] = useState<number>(() => Date.now());
  useEffect(() => { setLoadedAt(Date.now()); }, [pathname]);
  // Re-render every 30s so the "Updated Xm ago" label ages while you sit here.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // "/" focuses global search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !/INPUT|TEXTAREA/.test((document.activeElement?.tagName) || '')) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function onSearch(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const v = e.currentTarget.value.trim();
    if (!v) return;
    // Routing heuristic. We can't tell a wallet from a token mint by string
    // alone — both are 32-byte base58 pubkeys — so we route by VALIDITY, not by
    // guessing the kind:
    //   • Full-length pubkey (43–44 chars, valid base58) → wallet view. This is
    //     the high-intent case (someone pasted an address); /smart-money/{addr}
    //     resolves wallets and the page itself handles the not-a-wallet case.
    //   • Anything else (names, tickers, partial input) → leaderboard search.
    //   • Obviously-invalid base58-ish junk that's too short to be an address is
    //     NOT pushed to a wallet route (which would 404); it falls through to the
    //     forgiving leaderboard query instead.
    if (B58.test(v) && v.length >= PUBKEY_LEN_MIN) {
      router.push(`/smart-money/${v}`);
    } else {
      router.push(`/smart-money?q=${encodeURIComponent(v)}`);
    }
    e.currentTarget.blur();
  }

  const title = titleFor(pathname);

  return (
    <div className="app">
      <aside className="sidebar">
        <Link href="/" className="side-brand" aria-label="Smart Money — home">
          <span className="brand-mark" aria-hidden="true"><Activity size={14} /></span>
          <span className="brand-name"><b>Smart</b><span>Money</span></span>
        </Link>
        <nav className="side-nav" aria-label="Primary">
          {NAV.map((g) => (
            <React.Fragment key={g.group}>
              <div className="side-group" aria-hidden="true">{g.group}</div>
              {g.items.map((n) => {
                const Icon = n.icon;
                const active = owner === n.owner;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`side-link ${active ? 'active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    title={n.label}
                  >
                    <Icon size={16} /> <span>{n.label}</span>
                  </Link>
                );
              })}
            </React.Fragment>
          ))}
        </nav>
        <div className="side-foot">
          <div className="side-status">
            <span
              className={`net-dot ${fresh.live ? 'live' : ''}`}
              style={{ background: fresh.color, boxShadow: `0 0 0 3px ${fresh.color}22` }}
              aria-hidden="true"
            />{' '}
            <span className="mono">Solana mainnet</span>
          </div>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <h1 className="topbar-title">{title}</h1>
          <span className="topbar-sep" aria-hidden="true" />
          <span
            className="topbar-meta"
            title={
              `View loaded ${f.time(loadedAt)}` +
              (statusReady
                ? lastIndexMs
                  ? ` · smart-money index updated ${f.time(lastIndexMs)}`
                  : ' · index status unavailable'
                : '')
            }
          >
            <span
              className={`net-dot ${fresh.live ? 'live' : ''}`}
              style={{ background: fresh.color, boxShadow: `0 0 0 3px ${fresh.color}22` }}
              aria-hidden="true"
            />
            <span suppressHydrationWarning>{`Updated ${f.ago(loadedAt)}`}</span>
          </span>
          <div className="topbar-right">
            {/* Token-gating affordance. Renders ONLY when the gating flag is on
                AND a mint is configured (isGatingEnabled). With the flag off —
                production today — this branch is skipped entirely: GateControls
                never mounts, no wallet hooks run, zero visual change. */}
            {isGatingEnabled() && <GateControls />}
            <div className="topbar-search" role="search">
              <span className="search-ic" aria-hidden="true"><Search size={14} /></span>
              <label htmlFor="global-search" className="sr-only">Search wallet or token</label>
              <input
                id="global-search"
                ref={searchRef}
                type="search"
                placeholder="Search wallet or token…"
                aria-label="Search wallet or token"
                spellCheck={false}
                autoComplete="off"
                onKeyDown={onSearch}
              />
              <span className="kbd" aria-hidden="true">/</span>
            </div>
          </div>
        </header>
        <main className="main" id="main-content">{children}</main>
      </div>

      <nav className="mobile-nav" aria-label="Primary mobile">
        {NAV.flatMap((g) => g.items).map((n) => {
          const Icon = n.icon;
          const active = owner === n.owner;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`mnav-link ${active ? 'active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={20} />
              <span>{n.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
