import type { Metadata } from 'next';
import { Key, ShieldCheck, Clock } from 'lucide-react';

export const metadata: Metadata = {
  title: 'API Reference | Smart Money',
  description:
    'Public API reference for the smart-money tool: leaderboards, wallet scoring, token traders, and pipeline status.',
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
    desc: 'Pipeline health and indexing counters — total wallets indexed, deep-scan verified, and curated smart wallets.',
    params: [
      ['walletsIndexed', 'number', 'Total wallets tracked in the index.'],
      ['verifiedWallets', 'number', 'Wallets deep-scanned for an accurate ROI.'],
      ['smartWallets', 'number', 'Verified wallets that also clear the quality gate.'],
      ['migrationApplied', 'boolean', 'Whether the latest schema migration is applied.'],
    ],
    cache: 'no-store',
    res: {
      walletsIndexed: 248913,
      verifiedWallets: 12704,
      smartWallets: 1486,
      migrationApplied: true,
    },
  },
  {
    id: 'leaderboard',
    method: 'GET',
    path: '/api/smart-money',
    name: 'Leaderboard',
    desc: 'The top-ranked wallets. Each entry includes its rank, score, roiPct, tier (S/A/B/C), tags, and a verified flag.',
    params: [],
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
          tags: ['high-roi', 'sharpshooter'],
          verified: true,
        },
      ],
      totalWallets: 12704,
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
      ['sort', 'string', 'Ranking key — roi (default) or other score fields.'],
      ['limit', 'number', 'Max number of wallets to return (default 50).'],
      ['verified', '0 | 1', '1 (default) restricts to verified wallets; 0 includes unverified.'],
      ['gate', '0 | 1', '1 requires the smart quality gate; 0 (default) does not.'],
      ['format', 'json | addresses | csv', 'Output shape (default json).'],
    ],
    cache: 'public, 300s',
    res: {
      count: 1486,
      criteria: { minRoiPct: 50, minWinRate: 0.5, minTrades: 20 },
      wallets: [
        {
          address: '9xQe…stub',
          score: 88.1,
          pnl: 642.3,
          roiPct: 3920.0,
          tier: 'A',
          verified: true,
          winRate: 0.81,
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
      ['hours', 'number', 'Look-back window in hours (default 24).'],
      ['limit', 'number', 'Max number of tokens to return (default 50).'],
    ],
    cache: 'public, 60s',
    res: {
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
      ['min_pnl', 'number', 'Minimum realized PnL (SOL) to qualify.'],
      ['min_coins', 'number', 'Minimum number of profitable coins traded.'],
      ['coins', 'number', 'How many seed coins to scan (default 12).'],
      ['depth', 'number', "How deep to walk each coin's trader history (default 500)."],
    ],
    cache: 'no-store',
    res: {
      scanned: { coins: 12, traders: 5400 },
      candidates: [
        { address: '3Fr7…stub', realizedPnl: 124.5, profitableCoins: 7 },
      ],
    },
  },
  {
    id: 'score',
    method: 'GET',
    path: '/api/wallet/{address}/score',
    name: 'Wallet score',
    desc: 'Accurate all-time realized PnL and ROI% for a wallet (FIFO, SOL-denominated).',
    params: [
      ['address', 'string', 'base58 wallet address.'],
      ['max', 'number', 'Cap on trades to analyze (default 1500). Higher = more accurate, slower.'],
    ],
    cache: 'public, 120s',
    res: {
      address: '7Np4…stub',
      score: 94.2,
      roiPct: 8421.4,
      realizedPnl: 1284.6,
      winRate: 0.86,
      totalTrades: 980,
      verified: true,
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
    desc: 'Every wallet that traded a given coin, ranked by PnL.',
    params: [
      ['mint', 'string', 'Token mint address.'],
      ['winners', '0 | 1', '1 restricts results to profitable traders only.'],
      ['sort', 'string', 'Ranking key — e.g. total realized PnL.'],
      ['limit', 'number', 'Max number of traders to return (default 50).'],
    ],
    cache: 'public, 120s',
    res: {
      mint: 'So1…mint',
      traders: [
        { address: '7Np4…stub', realizedPnlSol: 281.4, roiPct: 5400.0, tier: 'S' },
      ],
    },
  },
  {
    id: 'recent',
    method: 'GET',
    path: '/api/tokens/recent',
    name: 'Recent tokens',
    desc: 'Recently-indexed coins, newest first.',
    params: [],
    cache: 'public, 120s',
    res: {
      tokens: [
        { mint: 'A1b2…stub', symbol: 'WIF', firstSeen: '2026-06-06T10:00:00Z' },
      ],
    },
  },
];

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
        <div className="sub">Read-only, public, cache-friendly JSON. No key required.</div>
        <div className="page-head-actions">
          <span className="net-pill"><span className="net-dot live" /> All systems operational</span>
        </div>
      </div>

      <div className="docs-grid">
        <aside className="docs-aside">
          <div className="docs-aside-inner stack gap-12">
            <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
              Endpoints
            </span>
            {ENDPOINTS.map((e) => (
              <a key={e.id} className="doc-nav-link" href={`#doc-${e.id}`}>
                <span className="method" style={{ height: 18, fontSize: 10 }}>{e.method}</span> {e.name}
              </a>
            ))}
          </div>
        </aside>

        <div className="stack gap-16">
          <div className="card card-pad" style={{ background: 'linear-gradient(150deg, rgba(109,118,245,0.08), transparent)' }}>
            <div className="row gap-12 wrap">
              <span className="stat-ic accent"><Key size={15} /></span>
              <div className="stack">
                <b>Base URL</b>
                <code className="mono faint" style={{ fontSize: 12.5 }}>{BASE_URL}</code>
              </div>
              <span className="spacer" />
              <span className="badge accent"><ShieldCheck size={11} /> No auth required</span>
            </div>
          </div>

          {ENDPOINTS.map((e) => (
            <EndpointCard key={e.id} e={e} />
          ))}
        </div>
      </div>
    </div>
  );
}
