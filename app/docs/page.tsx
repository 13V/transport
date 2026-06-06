import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'API Reference | Smart Money',
  description:
    'Public API reference for the smart-money tool: leaderboards, wallet scoring, token traders, and pipeline status.',
};

const BASE_URL = 'https://transport-topaz-eight.vercel.app';

// --- Small presentational helpers (still a plain server component) -----------

function Method({ children }: { children: string }) {
  return (
    <span className="inline-block px-2 py-0.5 rounded text-xs font-bold font-mono bg-green-900 text-green-200 mr-2 align-middle">
      {children}
    </span>
  );
}

function Path({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-sm text-cyan-300 break-all align-middle">
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-gray-900 border border-gray-800 rounded-lg p-4 overflow-x-auto text-sm leading-relaxed text-gray-200">
      <code className="font-mono whitespace-pre">{children}</code>
    </pre>
  );
}

function Param({
  name,
  desc,
}: {
  name: string;
  desc: React.ReactNode;
}) {
  return (
    <li className="flex flex-col sm:flex-row sm:gap-3">
      <code className="font-mono text-xs text-purple-300 shrink-0 sm:w-44 py-0.5">
        {name}
      </code>
      <span className="text-gray-400 text-sm">{desc}</span>
    </li>
  );
}

function Endpoint({
  method = 'GET',
  path,
  example,
  children,
}: {
  method?: string;
  path: string;
  example: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card space-y-3">
      <div>
        <Method>{method}</Method>
        <Path>{path}</Path>
      </div>
      <div className="text-gray-300 text-sm space-y-3">{children}</div>
      <div className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-gray-500 font-semibold">
          Example
        </p>
        <CodeBlock>{`curl ${BASE_URL}${example}`}</CodeBlock>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-4 scroll-mt-24">
      <h2 className="text-2xl font-bold text-blue-400 border-b border-gray-800 pb-2">
        {title}
      </h2>
      {children}
    </section>
  );
}

// --- Page --------------------------------------------------------------------

export default function DocsPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-12 py-8">
      {/* Header */}
      <header className="space-y-4">
        <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
          Smart Money API Reference
        </h1>
        <p className="text-lg text-gray-400">
          A public, read-only HTTP API for ranking Solana wallets by realized
          performance, exporting curated smart-money watchlists, and inspecting
          per-token trader activity. All endpoints return JSON unless otherwise
          noted.
        </p>
        <CodeBlock>{`Base URL   ${BASE_URL}`}</CodeBlock>
      </header>

      {/* Concepts */}
      <section className="card space-y-3">
        <h2 className="text-xl font-semibold text-cyan-400">Core concepts</h2>
        <ul className="space-y-2 text-sm text-gray-300">
          <li>
            <span className="font-semibold text-gray-100">Verified</span> — the
            wallet has been deep-scanned over its full trade history, producing
            an accurate ROI. Verified wallets are the only ones used in
            export/watchlist endpoints by default.
          </li>
          <li>
            <span className="font-semibold text-gray-100">Smart</span> — a
            verified wallet that additionally clears the quality gate (minimum
            ROI, realized volume, and trade-count thresholds). Every smart
            wallet is verified; not every verified wallet is smart.
          </li>
          <li>
            <span className="font-semibold text-gray-100">ROI</span> — realized
            profit-and-loss computed with <span className="text-gray-100">FIFO
            cost-basis denominated in SOL</span>. It reflects closed positions
            only; open positions are reported separately as unrealized PnL on the
            holdings endpoint.
          </li>
        </ul>
      </section>

      {/* Table of contents */}
      <nav className="card space-y-2">
        <h2 className="text-xs uppercase tracking-wide text-gray-500 font-semibold">
          On this page
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
          <a className="text-blue-400 hover:underline" href="#leaderboard">
            Leaderboard &amp; List
          </a>
          <a className="text-blue-400 hover:underline" href="#wallets">
            Wallets
          </a>
          <a className="text-blue-400 hover:underline" href="#tokens">
            Tokens
          </a>
          <a className="text-blue-400 hover:underline" href="#status">
            Status
          </a>
          <a className="text-blue-400 hover:underline" href="#definitions">
            Definitions
          </a>
        </div>
      </nav>

      {/* LEADERBOARD & LIST */}
      <Section id="leaderboard" title="Leaderboard & List">
        <Endpoint path="/api/smart-money" example="/api/smart-money">
          <p>
            The top-ranked wallets. Each entry includes its{' '}
            <code className="text-purple-300 font-mono text-xs">rank</code>,{' '}
            <code className="text-purple-300 font-mono text-xs">score</code>,{' '}
            <code className="text-purple-300 font-mono text-xs">roiPct</code>,{' '}
            <code className="text-purple-300 font-mono text-xs">tier</code>{' '}
            (S/A/B/C), <code className="text-purple-300 font-mono text-xs">tags</code>,
            and a <code className="text-purple-300 font-mono text-xs">verified</code>{' '}
            flag.
          </p>
        </Endpoint>

        <Endpoint
          path="/api/smart-money/list?sort=roi&limit=50&format=json&verified=1&gate=0"
          example="/api/smart-money/list?format=addresses&limit=100&sort=roi"
        >
          <p>
            The curated, exportable smart-wallet list. Designed for building
            external watchlists.
          </p>
          <ul className="space-y-1.5">
            <Param
              name="sort"
              desc={
                <>
                  Ranking key. <code className="text-gray-200">roi</code>{' '}
                  (default), or other supported score fields.
                </>
              }
            />
            <Param name="limit" desc="Max number of wallets to return (default 50)." />
            <Param
              name="verified"
              desc={
                <>
                  <code className="text-gray-200">1</code> (default) restricts to
                  verified wallets; <code className="text-gray-200">0</code>{' '}
                  includes unverified.
                </>
              }
            />
            <Param
              name="gate"
              desc={
                <>
                  <code className="text-gray-200">1</code> requires wallets to
                  clear the smart quality gate;{' '}
                  <code className="text-gray-200">0</code> (default) does not
                  enforce it.
                </>
              }
            />
            <Param
              name="format"
              desc={
                <>
                  Output shape — one of{' '}
                  <code className="text-gray-200">json</code>,{' '}
                  <code className="text-gray-200">addresses</code>, or{' '}
                  <code className="text-gray-200">csv</code> (see below).
                </>
              }
            />
          </ul>
          <div className="space-y-2 pt-1">
            <p className="text-xs uppercase tracking-wide text-gray-500 font-semibold">
              format=addresses
            </p>
            <p className="text-gray-400 text-sm">
              A plain, newline-delimited list of wallet addresses — nothing else.
              Ideal for piping into a terminal watchlist or a bot config.
            </p>
            <CodeBlock>{`5x...A1
9bQ...kE
3Fr...t7`}</CodeBlock>
            <p className="text-xs uppercase tracking-wide text-gray-500 font-semibold">
              format=csv
            </p>
            <p className="text-gray-400 text-sm">
              A spreadsheet-ready CSV with a header row and one wallet per line.
            </p>
            <CodeBlock>{`rank,address,score,roiPct,tier,verified
1,5x...A1,982,431.2,S,true
2,9bQ...kE,915,288.7,A,true`}</CodeBlock>
          </div>
        </Endpoint>

        <Endpoint
          path="/api/smart-money/buying?hours=24&limit=50"
          example="/api/smart-money/buying?hours=24&limit=50"
        >
          <p>
            Tokens that multiple verified smart wallets are buying right now,
            surfacing fresh consensus accumulation.
          </p>
          <ul className="space-y-1.5">
            <Param name="hours" desc="Look-back window in hours (default 24)." />
            <Param name="limit" desc="Max number of tokens to return (default 50)." />
          </ul>
        </Endpoint>

        <Endpoint
          path="/api/smart-money/discover?min_pnl=1&min_coins=1&coins=12&depth=500"
          example="/api/smart-money/discover?min_pnl=1&min_coins=1&coins=12&depth=500"
        >
          <p>
            A live, on-demand scan that discovers candidate wallets directly from
            chain data (no database). This runs synchronously and typically takes{' '}
            <span className="text-gray-100">~30-60 seconds</span> to complete.
          </p>
          <ul className="space-y-1.5">
            <Param name="min_pnl" desc="Minimum realized PnL (SOL) to qualify." />
            <Param
              name="min_coins"
              desc="Minimum number of profitable coins a wallet must have traded."
            />
            <Param name="coins" desc="How many seed coins to scan (default 12)." />
            <Param
              name="depth"
              desc="How deep to walk each coin's trader history (default 500)."
            />
          </ul>
        </Endpoint>
      </Section>

      {/* WALLETS */}
      <Section id="wallets" title="Wallets">
        <p className="text-gray-400 text-sm">
          Replace{' '}
          <code className="text-purple-300 font-mono text-xs">{'{address}'}</code>{' '}
          with a base58 Solana wallet address.
        </p>

        <Endpoint
          path="/api/wallet/{address}/score?max=1500"
          example="/api/wallet/5x...A1/score?max=1500"
        >
          <p>
            Accurate all-time realized PnL and ROI% for a wallet (FIFO,
            SOL-denominated).
          </p>
          <ul className="space-y-1.5">
            <Param
              name="max"
              desc="Cap on the number of trades to analyze (default 1500). Higher = more accurate, slower."
            />
          </ul>
        </Endpoint>

        <Endpoint
          path="/api/wallet/{address}/profile"
          example="/api/wallet/5x...A1/profile"
        >
          <p>
            A full profile: the score, a per-token PnL breakdown, recent trades,
            and the wallet&apos;s funding cluster.
          </p>
        </Endpoint>

        <Endpoint
          path="/api/wallet/{address}/holdings"
          example="/api/wallet/5x...A1/holdings"
        >
          <p>
            Current open positions marked to market, with unrealized PnL per
            holding.
          </p>
        </Endpoint>

        <Endpoint
          path="/api/wallet/{address}/links"
          example="/api/wallet/5x...A1/links"
        >
          <p>
            The funding graph for a wallet — which wallets it funded and which
            wallets funded it.
          </p>
        </Endpoint>

        <Endpoint
          path="/api/wallet/{address}/cluster"
          example="/api/wallet/5x...A1/cluster"
        >
          <p>
            The trader&apos;s whole entity: every wallet linked to it through the
            funding graph, resolved into a single cluster.
          </p>
        </Endpoint>
      </Section>

      {/* TOKENS */}
      <Section id="tokens" title="Tokens">
        <p className="text-gray-400 text-sm">
          Replace{' '}
          <code className="text-purple-300 font-mono text-xs">{'{mint}'}</code>{' '}
          with a token mint address.
        </p>

        <Endpoint
          path="/api/token/{mint}/traders?winners=1&sort=total&limit=50"
          example="/api/token/So1...mint/traders?winners=1&sort=total&limit=50"
        >
          <p>
            Every wallet that traded a given coin, ranked by PnL.
          </p>
          <ul className="space-y-1.5">
            <Param
              name="winners"
              desc={
                <>
                  <code className="text-gray-200">1</code> restricts results to
                  profitable traders only.
                </>
              }
            />
            <Param
              name="sort"
              desc={
                <>
                  Ranking key — e.g. <code className="text-gray-200">total</code>{' '}
                  realized PnL.
                </>
              }
            />
            <Param name="limit" desc="Max number of traders to return (default 50)." />
          </ul>
        </Endpoint>

        <Endpoint path="/api/tokens/recent" example="/api/tokens/recent">
          <p>Recently-indexed coins, newest first.</p>
        </Endpoint>
      </Section>

      {/* STATUS */}
      <Section id="status" title="Status">
        <Endpoint path="/api/status" example="/api/status">
          <p>Pipeline health and indexing counters.</p>
          <ul className="space-y-1.5">
            <Param
              name="walletsIndexed"
              desc="Total wallets tracked in the index."
            />
            <Param
              name="verifiedWallets"
              desc="Wallets that have been deep-scanned for an accurate ROI."
            />
            <Param
              name="smartWallets"
              desc="Verified wallets that also clear the quality gate."
            />
            <Param
              name="migrationApplied"
              desc="Whether the latest schema migration has been applied."
            />
          </ul>
        </Endpoint>
      </Section>

      {/* DEFINITIONS */}
      <Section id="definitions" title="Definitions">
        <div className="card space-y-4">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-100">Tier</h3>
            <p className="text-sm text-gray-400">
              A letter grade derived from a wallet&apos;s overall score —
              highest to lowest.
            </p>
            <ul className="space-y-1.5 text-sm">
              <Param name="S" desc="Elite — exceptional, sustained performance." />
              <Param name="A" desc="Strong — consistently profitable." />
              <Param name="B" desc="Solid — net positive but more variable." />
              <Param name="C" desc="Marginal — barely clears the bar." />
            </ul>
          </div>

          <div className="space-y-2 border-t border-gray-800 pt-4">
            <h3 className="text-lg font-semibold text-gray-100">Tags</h3>
            <p className="text-sm text-gray-400">
              Behavioral labels attached to a wallet. A wallet may carry several.
            </p>
            <ul className="space-y-1.5 text-sm">
              <Param name="high-roi" desc="ROI well above the cohort median." />
              <Param name="whale" desc="Trades at large size / high SOL volume." />
              <Param
                name="sharpshooter"
                desc="High win rate with few but well-timed entries."
              />
              <Param
                name="consistent"
                desc="Profitable across many coins over time, not one lucky hit."
              />
              <Param name="active" desc="Trades frequently and recently." />
              <Param
                name="diversified"
                desc="Spreads activity across many different tokens."
              />
            </ul>
          </div>
        </div>
      </Section>

      {/* Footer note */}
      <div className="bg-blue-900/20 border border-blue-800 rounded-lg p-6 text-sm text-gray-300 space-y-2">
        <p className="font-semibold text-blue-300">Note</p>
        <p>
          All metrics are derived from heuristics applied to public on-chain
          data and may not be 100% accurate. ROI reflects realized, FIFO
          cost-basis PnL in SOL. Always DYOR before trading.
        </p>
        <p>
          <Link href="/smart-money" className="text-blue-400 hover:underline">
            ← Back to the Smart Money Leaderboard
          </Link>
        </p>
      </div>
    </div>
  );
}
