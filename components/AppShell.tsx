'use client';

/* =========================================================================
   APP SHELL — left sidebar + slim topbar (terminal layout).
   Ported from the design prototype (app.js + theme.css shell).
   ========================================================================= */
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity, LayoutDashboard, Crown, Flame, Star, BookOpen, Search,
} from 'lucide-react';
import * as f from '@/lib/format';

interface NavItem { href: string; label: string; icon: React.ComponentType<{ size?: number }>; owner: string; }
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Analytics', items: [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard, owner: 'dashboard' },
    { href: '/smart-money', label: 'Leaderboard', icon: Crown, owner: 'leaderboard' },
    { href: '/smart-money/buying', label: 'Buying', icon: Flame, owner: 'buying' },
  ] },
  { group: 'You', items: [
    { href: '/watchlist', label: 'Watchlist', icon: Star, owner: 'watchlist' },
  ] },
  { group: 'Developer', items: [
    { href: '/docs', label: 'API', icon: BookOpen, owner: 'docs' },
  ] },
];

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function ownerFor(path: string): string {
  if (path === '/') return 'dashboard';
  if (path.startsWith('/smart-money/buying')) return 'buying';
  if (path.startsWith('/smart-money')) return 'leaderboard';
  if (path.startsWith('/token')) return 'buying';
  if (path.startsWith('/watchlist')) return 'watchlist';
  if (path.startsWith('/docs')) return 'docs';
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
  return 'Smart Money';
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const router = useRouter();
  const owner = ownerFor(pathname);
  const searchRef = useRef<HTMLInputElement>(null);
  const [updated, setUpdated] = useState<string>('');

  // client-only timestamp (avoids SSR hydration mismatch)
  useEffect(() => { setUpdated(f.time(Date.now())); }, [pathname]);

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
    if (B58.test(v)) router.push(`/smart-money/${v}`);
    else router.push(`/smart-money?q=${encodeURIComponent(v)}`);
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
            <span className="net-dot live" aria-hidden="true" /> <span className="mono">Solana mainnet</span>
          </div>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <h1 className="topbar-title">{title}</h1>
          <span className="topbar-sep" aria-hidden="true" />
          <span className="topbar-meta">
            <span className="net-dot live" aria-hidden="true" />
            <span>Updated <span suppressHydrationWarning>{updated || '—'}</span></span>
          </span>
          <div className="topbar-right">
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
