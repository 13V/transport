'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import SmartMoneyLeaderboard from '@/components/SmartMoneyLeaderboard';

function SmartMoneyView() {
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  return <SmartMoneyLeaderboard initialQuery={q} />;
}

export default function SmartMoneyPage() {
  return (
    <Suspense fallback={<SmartMoneyLeaderboard />}>
      <SmartMoneyView />
    </Suspense>
  );
}
