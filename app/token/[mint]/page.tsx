'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { TokenInsiderReport } from '@/lib/types';
import { calculateRiskScore } from '@/lib/risk-score';
import ReportView from '@/components/ReportView';
import LoadingState from '@/components/LoadingState';
import TokenSmartHolders from '@/components/TokenSmartHolders';

export default function TokenPage() {
  const params = useParams();
  const router = useRouter();
  const mint = params.mint as string;

  const [report, setReport] = useState<TokenInsiderReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
          const errorData = await response.json();
          throw new Error(errorData.error || 'Analysis failed');
        }

        const data = await response.json();
        if (data.success && data.report) {
          setReport(data.report);
        } else {
          throw new Error(data.error || 'No report generated');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Analysis failed');
      } finally {
        setLoading(false);
      }
    };

    if (mint) {
      fetchReport();
    }
  }, [mint]);

  if (loading) {
    return <LoadingState />;
  }

  if (error) {
    return (
      <div className="space-y-4">
        <button onClick={() => router.back()} className="btn btn-secondary">
          ← Back
        </button>
        <div className="card border-red-800 bg-red-900/20 text-red-200">
          <p className="font-semibold">Analysis Error</p>
          <p>{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="btn btn-primary mt-4"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="space-y-4">
        <button onClick={() => router.back()} className="btn btn-secondary">
          ← Back
        </button>
        <div className="card">No report available</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button onClick={() => router.back()} className="btn btn-secondary">
        ← Back
      </button>
      <ReportView report={report} />
      <TokenSmartHolders mint={mint} />
    </div>
  );
}
