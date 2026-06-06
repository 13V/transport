'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft, ExternalLink, FileSearch } from 'lucide-react';
import { TokenInsiderReport } from '@/lib/types';
import ReportView from '@/components/ReportView';
import TokenSmartHolders from '@/components/TokenSmartHolders';
import { ErrorState } from '@/components/ui';

/**
 * Deep insider analysis (creator / clusters / snipers) is heavy and not always
 * available for fresh pump coins — so it's an OPT-IN section below the smart-
 * money view, with its own contained error. It never blocks the page.
 */
function InsiderReport({ mint }: { mint: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'done'>('idle');
  const [report, setReport] = useState<TokenInsiderReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setState('loading');
    setError(null);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mint }),
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.report) {
        throw new Error(data.error || 'Analysis failed');
      }
      setReport(data.report);
      setState('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
      setState('error');
    }
  }

  if (state === 'done' && report) return <ReportView report={report} />;

  return (
    <div className="card card-pad">
      <div className="row between wrap gap-12">
        <div className="stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>Full insider analysis</span>
          <span className="faint" style={{ fontSize: 12.5 }}>
            Creator, funding clusters and sniper bundles — a deeper on-chain scan.
          </span>
        </div>
        {state !== 'error' && (
          <button className="btn sm" onClick={run} disabled={state === 'loading'}>
            <FileSearch size={15} /> {state === 'loading' ? 'Analyzing…' : 'Run analysis'}
          </button>
        )}
      </div>
      {state === 'error' && (
        <div style={{ marginTop: 12 }}>
          <ErrorState title="Analysis unavailable" msg={error || undefined} onRetry={run} />
        </div>
      )}
    </div>
  );
}

export default function TokenPage() {
  const params = useParams();
  const router = useRouter();
  const mint = (params.mint as string) || '';

  return (
    <div className="view stack gap-20">
      <div className="row between">
        <button className="btn ghost sm" onClick={() => router.back()}>
          <ChevronLeft size={15} /> Back
        </button>
        <a
          className="btn sm"
          href={`https://dexscreener.com/solana/${mint}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          DEXScreener <ExternalLink size={14} />
        </a>
      </div>

      {/* Primary: smart money in this coin (self-contained, own states) */}
      <TokenSmartHolders mint={mint} />

      {/* Secondary: opt-in deep insider report (never blocks the page) */}
      <InsiderReport mint={mint} />
    </div>
  );
}
