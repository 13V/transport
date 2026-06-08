import type { Metadata } from 'next';
import { Key, ShieldCheck, Clock, Compass, Lock, Send, Bell, Copy } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Docs | Smart Money',
  description:
    'Documentation hub for the smart-money tool: what it is and how it measures outcomes, access tiers, the Telegram bot, alerts, copy-trade, and the public API reference.',
};

const BASE_URL = 'https://transport-topaz-eight.vercel.app/api';

// --- JSON syntax highlighter → spans matching pre.code .k/.s/.n -------------
// Mirrors hl() in the design prototype (screens-docs.js): keys → .k, strings →
// .s, numbers/literals → .n. The input is escaped before highlighting and the
// only injected markup is our own spans, so dangerouslySetInnerHTML is safe.
function highlightJson(obj: unknown): string {
  let json = JSON.stringify(obj, null, 2);
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (match, str: string | undefined, colon: string | undefined) => {
      if (str !== undefined) {
        if (colon) return `<span class="k">${str}</span>${colon}`;
        return `<span class="s">${str}</span>`;
      }
      return `<span class="n">${match}</span>`;
    }
  );
}

type Param = [name: string, type: string, desc: string];

interface EndpointDoc {
  id: string;
  method: string;
  path: string;
  name: string;
  desc: string;
  params: Param[];
  cache: string;
  res: unknown;
}

// The repo's real, read-only endpoints (reusing the content documented in the
// previous app/docs page), shaped for the prototype's doc-section layout.
const ENDPOINTS: EndpointDoc[] = [
  {
    id: 'status',
    method: 'GET',
    path: '/api/status',
    name: 'Index status',
    desc: 'Pipeline health and indexing counters — total wallets indexed, deep-scan verified, and curated smart wallets, plus the last indexer run.',
    params: [],
    cache: 'no-store',
    res: {
      ok: true,
      generatedAt: '2026-06-06T12:00:00Z',
      migrationApplied: true,
      totals: {
        walletsIndexed: 248913,
        smartWallets: 1486,
        verifiedWallets: 12704,
      },
    },
  },
  {
    id: 'leaderboard',
    method: 'GET',
    path: '/api/smart-money',
    name: 'Leaderboard',
    desc: 'The top-ranked wallets, served straight from the precomputed index. Each entry includes its rank, score, roiPct, tier (S/A/B/C), tags, and a verified flag.',
    params: [
      ['limit', 'number', 'Page size — default 100, max 100.'],
      ['offset', 'number', 'Pagination cursor (default 0).'],
    ],
    cache: 'revalidate 60s',
    res: {
      leaderboard: [
        {
          rank: 1,
          address: '7Np41…stub',
          score: 94.2,
          roiPct: 8421.4,
          pnl: 1284.6,
          tier: 'S',
          tags: ['Early sniper', 'Diamond hands'],
          verified: true,
        },
      ],
      totalWallets: 12704,
      pagination: { offset: 0, limit: 100, hasMore: true },
      lastUpdated: '2026-06-06T12:00:00Z',
    },
  },
  {
    id: 'list',
    method: 'GET',
    path: '/api/smart-money/list',
    name: 'Curated wallet list',
    desc: 'The curated, exportable smart-wallet list — built for external watchlists or alert bots. Add ?format=addresses or ?format=csv for non-JSON output.',
    params: [
      ['sort', 'roi', 'Rank by ROI instead of the default score.'],
      ['limit', 'number', 'Max wallets to return — default 200, max 1000.'],
      ['verified', '0 | 1', '1 (default) restricts to deep-scanned verified wallets; 0 includes unverified.'],
      ['gate', '0 | 1', '1 (default) applies the smart-money quality gate; 0 returns verified wallets without it.'],
      ['format', 'json | addresses | csv', 'Output shape (default json).'],
    ],
    cache: 'public, 300s',
    res: {
      count: 1486,
      criteria: { minRoiPct: 50, minWinRate: 0.5, minTrades: 20 },
      generatedAt: '2026-06-06T12:00:00Z',
      wallets: [
        {
          address: '9xQe…stub',
          score: 88.1,
          pnl: 642.3,
          roiPct: 3920.0,
          investedSol: 16.4,
          verified: true,
          winRate: 0.81,
          consistency: 84,
          totalTrades: 412,
          tokensTraded: 96,
          lastTradeAt: '2026-06-06T10:14:00Z',
          seeded: false,
        },
      ],
    },
  },
  {
    id: 'buying',
    method: 'GET',
    path: '/api/smart-money/buying',
    name: 'Buying feed',
    desc: 'Tokens that multiple verified smart wallets are buying right now, surfacing fresh consensus accumulation.',
    params: [
      ['hours', 'number', 'Look-back window in hours — clamped 1–168 (default 24).'],
      ['limit', 'number', 'Max number of tokens to return — clamped 1–200 (default 50).'],
    ],
    cache: 'public, 60s',
    res: {
      generatedAt: '2026-06-06T12:00:00Z',
      hours: 24,
      count: 14,
      tokens: [
        {
          mint: 'A1b2…stub',
          distinctSmartBuyers: 23,
          buys: 51,
          solVolume: 842.6,
          firstBuy: '2026-06-05T18:00:00Z',
          lastBuy: '2026-06-06T11:42:00Z',
          sampleBuyers: ['7Np4…', '9xQe…'],
        },
      ],
    },
  },
  {
    id: 'live',
    method: 'GET',
    path: '/api/smart-money/live',
    name: 'Live buy bursts',
    desc: 'Buy bursts — moments where ≥N distinct smart-money entities bought the SAME token inside a short window. The live, time-sensitive feed: "smart money just piled into X." Each burst has a stable content-hash id (constant as the window absorbs more buys, so clients can dedupe), a finalized flag, and the response carries a nextCursor for ?since= polling. Free and key-less.',
    params: [
      ['windowSec', 'number', 'Burst window in seconds — clamped 5–300 (default 30).'],
      ['minBuyers', 'number', 'Distinct entities required to fire — clamped 2–20 (default 3).'],
      ['hours', 'number', 'Look-back window in hours — clamped 1–48 (default 6).'],
      ['limit', 'number', 'Max bursts to return — clamped 1–200 (default 50).'],
      ['minSol', 'number', 'Only bursts with solTotal ≥ minSol (default 0).'],
      ['since', 'iso | ms', 'Only bursts with windowEnd > since — pass back the prior nextCursor to fetch only newer bursts (bot polling).'],
      ['sort', 'quality | recent', 'Ranking — quality (default, tier-weighted conviction + size) or recent (newest first).'],
    ],
    cache: 'public, 2s + SWR',
    res: {
      generatedAt: '2026-06-06T12:00:00Z',
      windowSec: 30,
      minBuyers: 3,
      count: 1,
      nextCursor: '2026-06-06T11:59:48Z',
      bursts: [
        {
          id: 'a1b2c3d4e5f60718',
          mint: 'A1b2…stub',
          buyers: 4,
          buyerWallets: 5,
          solTotal: 128.42,
          windowStart: '2026-06-06T11:59:21Z',
          windowEnd: '2026-06-06T11:59:48Z',
          sampleBuyers: ['7Np4…', '9xQe…'],
          tiers: ['S', 'A', null, 'B'],
          finalized: true,
          symbol: 'WIF',
          marketCapUsd: 184000000,
          liquidityUsd: 920000,
          priceChange24h: 12.4,
        },
      ],
    },
  },
  {
    id: 'discover',
    method: 'GET',
    path: '/api/smart-money/discover',
    name: 'Live discovery scan',
    desc: 'A live, on-demand scan that discovers candidate wallets directly from chain data (no database). Runs synchronously and typically takes ~30–60 seconds.',
    params: [
      ['coins', 'number', 'How many seed coins to scan — default 12, max 25.'],
      ['depth', 'number', "How deep to walk each coin's trader history — default 300, max 1000."],
      ['min_coins', 'number', 'Minimum number of winning coins to qualify (default 1).'],
      ['min_pnl', 'number', 'Minimum realized PnL (SOL) to qualify (default 0).'],
      ['format', 'json | addresses | csv', 'Output shape (default json).'],
    ],
    cache: 'no-store',
    res: {
      coinsScanned: 12,
      walletCount: 5400,
      returned: 100,
      elapsedMs: 41200,
      filters: { minCoins: 1, minPnl: 0, coins: 12, depth: 300 },
      wallets: [
        {
          wallet: '3Fr7…stub',
          realizedPnl: 124.5,
          unrealizedPnl: 18.2,
          totalPnl: 142.7,
          coinsTraded: 14,
          coinsWon: 7,
          buys: 21,
          sells: 12,
        },
      ],
    },
  },
  {
    id: 'score',
    method: 'GET',
    path: '/api/wallet/{address}/score',
    name: 'Wallet score',
    desc: 'A live FIFO replay of a wallet’s on-chain swap history → accurate all-time realized PnL, ROI%, win rate, and consistency (SOL-denominated).',
    params: [
      ['address', 'string', 'base58 wallet address.'],
      ['max', 'number', 'Cap on trades to analyze — default 1500, max 3000. Higher = more accurate, slower.'],
    ],
    cache: 'public, 120s',
    res: {
      wallet: '7Np4…stub',
      realizedPnlSol: 1284.6,
      investedSol: 15.3,
      roiPct: 8421.4,
      winRate: 0.86,
      consistency: 0.91,
      tokensTraded: 210,
      closedTokens: 188,
      totalTrades: 980,
      tradesScanned: 1500,
      lastTradeAt: '2026-06-06T11:50:00Z',
    },
  },
  {
    id: 'profile',
    method: 'GET',
    path: '/api/wallet/{address}/profile',
    name: 'Wallet profile',
    desc: 'A full profile: the score, a per-token PnL breakdown, recent trades, and the wallet’s funding cluster.',
    params: [['address', 'string', 'base58 wallet address.']],
    cache: 'public, 120s',
    res: {
      address: '7Np4…stub',
      stats: { score: 94.2, roiPct: 8421.4, realizedPnl: 1284.6, winRate: 0.86 },
      perToken: {
        best: [{ mint: 'WIF…', realizedPnlSol: 281.4, roiPct: 5400.0 }],
        worst: [{ mint: 'SC…', realizedPnlSol: -42.1, roiPct: -88.0 }],
      },
      recentTrades: [
        { mint: 'BONK…', type: 'BUY', amountSol: 12.4, source: 'RAYDIUM', at: '2026-06-06T11:50:00Z' },
      ],
      cluster: { funded: [], fundedBy: [] },
    },
  },
  {
    id: 'holdings',
    method: 'GET',
    path: '/api/wallet/{address}/holdings',
    name: 'Holdings',
    desc: 'Current open positions marked to market against live SOL prices, with unrealized PnL per holding.',
    params: [['address', 'string', 'base58 wallet address.']],
    cache: 'public, 60s',
    res: {
      address: '7Np4…stub',
      holdings: [
        { mint: 'POPCAT…', tokens: 4200000, currentValueSol: 38.21, unrealizedSol: 12.6 },
      ],
      totals: { unrealizedSol: 24.8, currentValueSol: 96.4 },
    },
  },
  {
    id: 'links',
    method: 'GET',
    path: '/api/wallet/{address}/links',
    name: 'Funding links',
    desc: 'The funding graph for a wallet — which wallets it funded and which wallets funded it.',
    params: [['address', 'string', 'base58 wallet address.']],
    cache: 'public, 120s',
    res: {
      address: '7Np4…stub',
      funded: [{ wallet: 'C3dE…', amountSol: 24.0 }],
      fundedBy: [{ wallet: 'B2aF…', amountSol: 50.0 }],
    },
  },
  {
    id: 'cluster',
    method: 'GET',
    path: '/api/wallet/{address}/cluster',
    name: 'Entity cluster',
    desc: 'The trader’s whole entity: every wallet linked through the funding graph, resolved into a single cluster.',
    params: [['address', 'string', 'base58 wallet address.']],
    cache: 'public, 120s',
    res: {
      address: '7Np4…stub',
      memberCount: 4,
      members: [
        { wallet: '7Np4…', roiPct: 8421.4, verified: true },
        { wallet: 'C3dE…', roiPct: 210.0, verified: true },
      ],
      edges: [{ source: '7Np4…', target: 'C3dE…', amountSol: 24.0 }],
    },
  },
  {
    id: 'traders',
    method: 'GET',
    path: '/api/token/{mint}/traders',
    name: 'Token traders',
    desc: 'Every wallet that traded a given coin, with per-coin realized/unrealized PnL and ROI from a FIFO replay, ranked by PnL.',
    params: [
      ['mint', 'string', 'Token mint address.'],
      ['winners', '0 | 1', '1 restricts results to profitable traders only.'],
      ['sort', 'total | realized', 'Rank by total (default) or realized PnL.'],
      ['limit', 'number', 'Max traders to return — default 100, max 500.'],
    ],
    cache: 'public, 120s',
    res: {
      mint: 'So1…mint',
      txScanned: 5400,
      traderCount: 312,
      markPrice: 0.000009,
      sort: 'total',
      returned: 50,
      traders: [
        {
          wallet: '7Np4…stub',
          realizedPnl: 281.4,
          unrealizedPnl: 12.6,
          totalPnl: 294.0,
          roi: 54.0,
          buys: 8,
          sells: 5,
          firstTradeAt: '2026-06-05T18:00:00Z',
          lastTradeAt: '2026-06-06T11:42:00Z',
        },
      ],
    },
  },
  {
    id: 'recent',
    method: 'GET',
    path: '/api/tokens/recent',
    name: 'Recent tokens',
    desc: 'Recently-traded coins for jumping straight to their trader breakdown — pump.fun mints first, then most recently traded.',
    params: [
      ['limit', 'number', 'How many mints to return — default 30, max 100.'],
      ['pump', '0 | 1', '1 returns only pump.fun coins (mints ending in "pump").'],
    ],
    cache: 'public, 120s',
    res: {
      count: 30,
      coins: [
        {
          mint: 'A1b2…stub',
          trades: 142,
          lastTradeAt: '2026-06-06T10:00:00Z',
          tradersUrl: '/api/token/A1b2…stub/traders?winners=1&limit=20',
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// GUIDE SECTIONS — product / methodology / access / bot / alerts / copy-trade.
// Anchored .doc-section blocks added ABOVE the API reference. Server-rendered,
// no client hooks — plain markup + anchors reusing the existing CSS tokens.
// ---------------------------------------------------------------------------

interface GuideNavItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}

const GUIDE_NAV: GuideNavItem[] = [
  { id: 'overview', label: 'Overview', icon: Compass },
  { id: 'access', label: 'Access & tiers', icon: Lock },
  { id: 'telegram', label: 'Telegram bot', icon: Send },
  { id: 'alerts', label: 'Alerts & watch rules', icon: Bell },
  { id: 'copy-trade', label: 'Copy-trade', icon: Copy },
];

function SectionHead({
  icon: Icon,
  title,
  sub,
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  sub: string;
}) {
  return (
    <div className="row gap-12 wrap">
      <span className="stat-ic accent"><Icon size={15} /></span>
      <div className="stack">
        <b>{title}</b>
        <span className="faint" style={{ fontSize: 12.5 }}>{sub}</span>
      </div>
    </div>
  );
}

const P: React.CSSProperties = { margin: 0, fontSize: 13.5 };
const LABEL: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  fontWeight: 600,
};

function OverviewSection() {
  return (
    <section className="doc-section" id="doc-overview">
      <div className="card card-pad stack gap-12">
        <SectionHead
          icon={Compass}
          title="Overview"
          sub="Real-time smart-money burst detection, with every call measured."
        />
        <p className="muted" style={P}>
          This tool watches what curated <b>smart-money</b> wallets do on Solana
          in real time and surfaces <b>buy bursts</b> — moments where multiple
          proven wallets pile into the same token inside a short window, before it
          trends. It pairs the live feed with honest, measured outcomes so you can
          judge the edge for yourself.
        </p>

        <div className="stack gap-8" style={{ marginTop: 6 }}>
          <span className="faint" style={LABEL}>How it works (and our honesty stance)</span>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6 }}>
            <li>
              <b>Bursts</b> = ≥N distinct verified entities buying the same token
              in a short window (default 3 buyers / 30s; tunable per query and per
              alert).
            </li>
            <li>
              <b>Entity clustering</b> collapses one actor&apos;s many wallets into
              a single entity via the funding graph, so a burst counts distinct
              players — not the same whale splitting across wallets.
            </li>
            <li>
              <b>Accurate PnL.</b> Wallets are <b>FIFO-replayed</b> over their
              on-chain swap history for accurate all-time realized PnL, ROI%, win
              rate, and consistency (SOL-denominated).
            </li>
            <li>
              <b>Every call is measured.</b> Each burst&apos;s outcome is tracked
              against real price history and published — wins <i>and</i> losses.
              See the{' '}
              <a className="endpoint" style={{ textDecoration: 'underline' }} href="/backtest">
                /backtest
              </a>{' '}
              page for the measured hit-rates and returns.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function AccessSection() {
  const tiers: { tier: string; gate: string; how: string; env: string }[] = [
    {
      tier: 'Free',
      gate: 'No key — open',
      how: 'Web feeds + read-only polling API (incl. live bursts with ?since= cursor).',
      env: '—',
    },
    {
      tier: 'Telegram alerts',
      gate: 'Hold ≥ 1,000,000 gate tokens',
      how: 'DM alerts from the bot. Bind a wallet with /verify, then sign to prove ownership.',
      env: 'TG_GATE_MIN_AMOUNT',
    },
    {
      tier: 'Web premium',
      gate: 'Hold ≥ 500,000 worth',
      how: 'Unlocks copy-trade SOL presets in the web app. Sign to prove ownership.',
      env: 'TOKEN_GATE_MIN_AMOUNT',
    },
    {
      tier: 'API / SSE',
      gate: 'Pay per period',
      how: 'Pay API_PRICE_SOL SOL on-chain to the treasury → an expiring API key is auto-minted (push SSE + higher limits).',
      env: 'API_PRICE_SOL · API_PERIOD_DAYS',
    },
  ];
  return (
    <section className="doc-section" id="doc-access">
      <div className="card card-pad stack gap-12">
        <SectionHead
          icon={Lock}
          title="Access & tiers"
          sub="Non-custodial throughout — you sign to prove ownership; you never hand over funds or keys."
        />

        <div style={{ overflowX: 'auto' }}>
          <table className="docs-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr>
                {['Tier', 'Gate', 'What you get', 'Env key'].map((h) => (
                  <th key={h} className="faint" style={{ ...LABEL, textAlign: 'left', padding: '6px 12px 6px 0', borderBottom: '1px solid var(--border)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.tier}>
                  <td style={{ padding: '8px 12px 8px 0', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>
                    <b>{t.tier}</b>
                  </td>
                  <td className="muted" style={{ padding: '8px 12px 8px 0', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>
                    {t.gate}
                  </td>
                  <td className="muted" style={{ padding: '8px 12px 8px 0', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>
                    {t.how}
                  </td>
                  <td style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>
                    <code className="mono faint" style={{ fontSize: 11.5 }}>{t.env}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="stack gap-8" style={{ marginTop: 6 }}>
          <span className="faint" style={LABEL}>Non-custodial flows</span>
          <p className="muted" style={P}>
            For the <b>hold-gates</b> (Telegram + web premium) you connect a Solana
            wallet and <b>sign a one-line challenge</b> to prove you own it — no
            funds move and no keys leave your wallet. The server reads your real
            on-chain gate-token balance and unlocks if you&apos;re over the
            threshold. For <b>API access</b> you pay{' '}
            <code className="mono">API_PRICE_SOL</code> SOL <b>directly to the
            treasury on-chain</b>; the payment is verified on-chain (the net
            lamports into the treasury), redeemed once, and a <b>hashed,
            expiring</b> key is minted and shown to you a single time. Manage all
            of this on the{' '}
            <a className="endpoint" style={{ textDecoration: 'underline' }} href="/access">
              /access
            </a>{' '}
            page.
          </p>
        </div>

        <div className="stack gap-8" style={{ marginTop: 6 }}>
          <span className="faint" style={LABEL}>Honesty note — gating is config-gated</span>
          <p className="muted" style={P}>
            Until the operator configures monetization, the gates are{' '}
            <b>open</b> and payment is <b>disabled</b>. Specifically: while{' '}
            <code className="mono">TOKEN_GATE_MINT</code> is unset the hold-gates
            return open (everyone is treated as premium / alert-eligible), and
            while <code className="mono">TREASURY_WALLET</code> is unset API
            payments are unavailable. The{' '}
            <a className="endpoint" style={{ textDecoration: 'underline' }} href="/access">
              /access
            </a>{' '}
            page mirrors this, showing &quot;monetization not yet configured&quot;
            for any tier that isn&apos;t live yet.
          </p>
        </div>
      </div>
    </section>
  );
}

function TelegramSection() {
  const cmds: [string, string][] = [
    ['/start', 'Registers your chat and shows the welcome + the measured 24h hit-rate. Run it first.'],
    ['/watch <wallet>', "Always alert when this Solana wallet joins a burst, regardless of your filters (up to 20 watched)."],
    ['/unwatch <wallet>', 'Remove a wallet from your watchlist.'],
    ['/filters minbuyers=.. minsol=.. holding=on|off', 'Tune your alert thresholds: minimum distinct buyers (int), minimum SOL in the burst (number), and holding-only on/off.'],
    ['/mute', 'Pause all alerts (settings kept).'],
    ['/unmute', 'Resume alerts.'],
    ['/status', 'Show your current prefs plus the measured 24h edge (bursts, hit-rate, median return).'],
    ['/verify', 'Deep-link to /access?chat_id=… to bind a wallet for the gated alert tier (see below).'],
    ['/stop', 'Delete your subscription entirely. Send /start to come back.'],
  ];
  return (
    <section className="doc-section" id="doc-telegram">
      <div className="card card-pad stack gap-12">
        <SectionHead
          icon={Send}
          title="Telegram bot"
          sub="Get a DM the moment smart money piles into a token — with one-tap Ape buttons."
        />
        <p className="muted" style={P}>
          <b>Getting started:</b> open the bot in Telegram and send{' '}
          <code className="mono">/start</code>. You&apos;re registered instantly and
          each alert ships with one-tap trade buttons (Axiom / GMGN / BullX /
          Photon / Jupiter) that open the swap in your own wallet.
        </p>

        <div className="stack gap-8" style={{ marginTop: 6 }}>
          <span className="faint" style={LABEL}>Commands</span>
          {cmds.map(([cmd, desc]) => (
            <div key={cmd} className="row gap-12 wrap" style={{ fontSize: 12.5, alignItems: 'baseline' }}>
              <code className="mono" style={{ color: 'var(--text)', minWidth: 150 }}>{cmd}</code>
              <span className="faint" style={{ flex: 1, minWidth: 220 }}>{desc}</span>
            </div>
          ))}
        </div>

        <div className="stack gap-8" style={{ marginTop: 6 }}>
          <span className="faint" style={LABEL}>Verifying for gated alerts</span>
          <p className="muted" style={P}>
            <code className="mono">/verify</code> replies with a deep link to{' '}
            <code className="mono">/access?chat_id=&lt;your chat&gt;</code>. On that
            page you connect a Solana wallet and <b>sign</b> a one-line message
            (ownership proof only — no funds, no keys), which binds the wallet to
            your chat. Once that wallet holds at least the Telegram threshold
            (<code className="mono">TG_GATE_MIN_AMOUNT</code>, default 1,000,000),
            gated alerts flow. If the balance later drops below the threshold,
            alerts pause until it&apos;s topped back up. (While{' '}
            <code className="mono">TOKEN_GATE_MINT</code> is unconfigured the gate
            is open and alerts flow without a hold.)
          </p>
        </div>
      </div>
    </section>
  );
}

function AlertsSection() {
  return (
    <section className="doc-section" id="doc-alerts">
      <div className="card card-pad stack gap-12">
        <SectionHead
          icon={Bell}
          title="Alerts & watch rules"
          sub="On-site browser-push alerts for bursts that match your own rules."
        />
        <p className="muted" style={P}>
          The{' '}
          <a className="endpoint" style={{ textDecoration: 'underline' }} href="/alerts">
            /alerts
          </a>{' '}
          page lets you create custom <b>watch rules</b> that fire a browser{' '}
          <b>web-push</b> notification when a smart-money burst matches. Each rule
          has:
        </p>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6 }}>
          <li><b>Wallets</b> — optional; if set, the burst must include one of them (empty = any wallet).</li>
          <li><b>Min buyers</b> — minimum distinct buyers in the burst.</li>
          <li><b>Min SOL</b> — minimum cumulative SOL value of the burst.</li>
          <li><b>Holding-only</b> — only fire for wallets already on your watchlist.</li>
        </ul>
        <p className="muted" style={P}>
          Push is the delivery channel on this page (rules are keyed to your
          device). Each rule can be <b>muted</b> individually to pause it without
          deleting it. Telegram delivery is handled separately by the bot above.
        </p>
      </div>
    </section>
  );
}

function CopyTradeSection() {
  return (
    <section className="doc-section" id="doc-copy-trade">
      <div className="card card-pad stack gap-12">
        <SectionHead
          icon={Copy}
          title="Copy-trade"
          sub="One-click trading from alerts and feeds — fully non-custodial."
        />
        <p className="muted" style={P}>
          The <b>Copy</b> / <b>Ape</b> button builds a <b>prefilled swap deep
          link</b> (Axiom / GMGN / Jupiter, with our referral codes) and opens it
          in a new tab so you complete the trade in <b>your own wallet</b>. Nothing
          is signed or sent server-side, and we never hold keys or funds.
        </p>
        <p className="muted" style={P}>
          <b>Web-premium users</b> get quick <b>SOL amount presets</b> (0.1 / 0.5
          / 1 / 5), saved per source-wallet, that are carried into the deep link so
          the size is prefilled. Free users get the one-click button without
          presets.
        </p>
        <p className="faint" style={{ ...P, fontSize: 12.5 }}>
          <ShieldCheck size={11} style={{ verticalAlign: 'middle' }} /> Custodial
          auto-execution is <b>not enabled</b> — the engine is scaffolded but
          disabled, so no trade is ever placed on your behalf.
        </p>
      </div>
    </section>
  );
}

function EndpointCard({ e }: { e: EndpointDoc }) {
  return (
    <section className="doc-section" id={`doc-${e.id}`}>
      <div className="card card-pad stack gap-12">
        <div className="row gap-12 wrap">
          <span className="method">{e.method}</span>
          <code className="endpoint">{e.path}</code>
          <span className="spacer" />
          <span className="badge tag"><Clock size={11} /> {e.cache}</span>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>{e.desc}</p>
        {e.params.length > 0 && (
          <div className="stack gap-8" style={{ marginTop: 14 }}>
            <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>
              Parameters
            </span>
            {e.params.map(([n, t, d]) => (
              <div key={n} className="row gap-12" style={{ fontSize: 12.5 }}>
                <code className="mono" style={{ color: 'var(--text)', minWidth: 88 }}>{n}</code>
                <span className="badge tag">{t}</span>
                <span className="faint">{d}</span>
              </div>
            ))}
          </div>
        )}
        <div className="stack gap-8" style={{ marginTop: 6 }}>
          <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>
            Example response
          </span>
          <pre className="code" dangerouslySetInnerHTML={{ __html: highlightJson(e.res) }} />
        </div>
      </div>
    </section>
  );
}

export default function DocsPage() {
  return (
    <div className="view stack gap-24">
      <div className="page-head">
        <div className="sub">
          The documentation hub: what the tool is and how it measures every call,
          access tiers, the Telegram bot, alerts, copy-trade — plus the full
          read-only API reference. Public, cache-friendly JSON needs no key;
          real-time push (SSE) is a pro-key surface.
        </div>
        <div className="page-head-actions">
          <span className="net-pill"><span className="net-dot live" /> All systems operational</span>
        </div>
      </div>

      <div className="docs-grid">
        <aside className="docs-aside">
          <div className="docs-aside-inner stack gap-12">
            <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
              Guide
            </span>
            {GUIDE_NAV.map((g) => (
              <a key={g.id} className="doc-nav-link" href={`#doc-${g.id}`}>
                <g.icon size={13} /> {g.label}
              </a>
            ))}
            <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginTop: 6 }}>
              Endpoints
            </span>
            {ENDPOINTS.map((e) => (
              <a key={e.id} className="doc-nav-link" href={`#doc-${e.id}`}>
                <span className="method" style={{ height: 18, fontSize: 10 }}>{e.method}</span> {e.name}
              </a>
            ))}
            <a className="doc-nav-link" href="#doc-realtime">
              <span className="method" style={{ height: 18, fontSize: 10 }}>SSE</span> Real-time for bots
            </a>
          </div>
        </aside>

        <div className="stack gap-16">
          <OverviewSection />
          <AccessSection />
          <TelegramSection />
          <AlertsSection />
          <CopyTradeSection />

          <div className="card card-pad" style={{ marginTop: 8, background: 'linear-gradient(150deg, rgba(109,118,245,0.08), transparent)' }}>
            <div className="row gap-12 wrap">
              <span className="stat-ic accent"><Key size={15} /></span>
              <div className="stack">
                <b>API reference · Base URL</b>
                <code className="mono faint" style={{ fontSize: 12.5 }}>{BASE_URL}</code>
              </div>
              <span className="spacer" />
              <span className="badge accent"><ShieldCheck size={11} /> No auth required</span>
            </div>
          </div>

          {ENDPOINTS.map((e) => (
            <EndpointCard key={e.id} e={e} />
          ))}

          <RealtimeSection />
        </div>
      </div>
    </div>
  );
}

function RealtimeSection() {
  return (
    <section className="doc-section" id="doc-realtime">
      <div className="card card-pad stack gap-12">
        <div className="row gap-12 wrap">
          <span className="stat-ic accent"><ShieldCheck size={15} /></span>
          <div className="stack">
            <b>Real-time for bots</b>
            <span className="faint" style={{ fontSize: 12.5 }}>
              Three ways to consume bursts live — pick one by how hands-off you need to be.
            </span>
          </div>
        </div>

        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          <b>Auth model.</b> The polling endpoints above are free and need no key.
          The push-based SSE stream is the paid surface and requires an API key.
          A <code className="mono">pro</code> key unlocks the SSE stream and higher
          rate limits; a <code className="mono">free</code> tier key (or no key)
          stays on polling. Send your key as{' '}
          <code className="mono">Authorization: Bearer &lt;key&gt;</code> or{' '}
          <code className="mono">?key=&lt;key&gt;</code>.
        </p>

        {/* (a) SSE stream */}
        <div className="stack gap-8" style={{ marginTop: 6 }}>
          <div className="row gap-12 wrap">
            <span className="method">GET</span>
            <code className="endpoint">/api/smart-money/live/stream</code>
            <span className="spacer" />
            <span className="badge accent"><Key size={11} /> API key required</span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            Server-Sent Events. Holds the connection open and pushes each NEW
            burst the instant it appears — no polling. Accepts the same{' '}
            <code className="mono">windowSec</code> and{' '}
            <code className="mono">minBuyers</code> params, and an optional{' '}
            <code className="mono">?since=</code> to seed the starting point.
            Each event is one burst:
          </p>
          <pre className="code" dangerouslySetInnerHTML={{ __html: highlightJson({
            id: '2026-06-06T11:59:48Z',
            event: 'burst',
            data: '<JSON of one burst, same shape as /live bursts[]>',
          }) }} />
          <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
            On the wire each frame is{' '}
            <code className="mono">id: &lt;windowEnd ISO&gt;</code>,{' '}
            <code className="mono">event: burst</code>,{' '}
            <code className="mono">data: &lt;burst JSON&gt;</code>, then a blank
            line. The connection closes by design after ~60s (platform cap) — your
            client reconnects automatically, and the browser EventSource (or a
            bot replaying the last <code className="mono">id</code> via the{' '}
            <code className="mono">Last-Event-ID</code> header) resumes exactly
            where it left off, so no bursts are missed or duplicated. A heartbeat
            comment is sent every ~15s to keep proxies from dropping idle
            connections.
          </p>
        </div>

        {/* (b) free polling with cursor */}
        <div className="stack gap-8" style={{ marginTop: 6 }}>
          <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>
            Free option — poll with a cursor
          </span>
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            No key needed. Poll <code className="mono">GET /api/smart-money/live</code>,
            then on each subsequent request pass the prior response&apos;s{' '}
            <code className="mono">nextCursor</code> back as{' '}
            <code className="mono">?since=</code>. You&apos;ll only receive bursts
            newer than your cursor. Bursts carry a stable{' '}
            <code className="mono">id</code> so you can dedupe across overlapping
            polls, and a <code className="mono">finalized</code> flag once a
            window can no longer absorb new buys.
          </p>
        </div>

        {/* (c) Supabase Realtime */}
        <div className="stack gap-8" style={{ marginTop: 6 }}>
          <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>
            Raw firehose — Supabase Realtime
          </span>
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            If you want the raw trade stream rather than detected bursts, the{' '}
            <code className="mono">trades</code> table is subscribable via Supabase
            Realtime using the public anon key. You subscribe to inserts and run
            your own burst logic client-side. The SSE stream above does this
            detection for you against the curated smart-money set.
          </p>
        </div>
      </div>
    </section>
  );
}
