'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { TokenInsiderReport } from '@/lib/types';
import ReportView from '@/components/ReportView';
import LoadingState from '@/components/LoadingState';
import TokenSmartHolders from '@/components/TokenSmartHolders';
import { ErrorState } from '@/components/ui';

export default function TokenPage() {
  const params = useParams();
  const router = useRouter();
  const mint = params.mint as string;

  const [report, setReport] = useState<TokenInsiderReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const fetchReport = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mint }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData?.error || 'Analysis failed');
        }

        const data = await response.json();
        if (data?.success && data?.report) {
          if (!cancelled) setReport(data.report);
        } else {
          throw new Error(data?.error || 'No report generated');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Analysis failed');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    if (mint) {
      fetchReport();
    }
    return () => {
      cancelled = true;
    };
  }, [mint, reloadKey]);

  const header = (
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
  );

  if (loading) {
    return <LoadingState />;
  }

  if (error) {
    return (
      <div className="view stack gap-20">
        {header}
        <div className="card">
          <ErrorState
            title="Analysis error"
            msg={error}
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="view stack gap-20">
        {header}
        <div className="card">
          <ErrorState
            title="No report available"
            msg="We couldn’t generate an insider report for this token."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="view stack gap-20">
      {header}
      <ReportView report={report} />
      <TokenSmartHolders mint={mint} />
    </div>
  );
}
