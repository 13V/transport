'use client';

import { use } from 'react';
import WalletProfile from '@/components/WalletProfile';
import WalletDetail from '@/components/WalletDetail';

interface WalletDetailPageProps {
  params: Promise<{
    wallet: string;
  }>;
}

export default function WalletDetailPage({ params }: WalletDetailPageProps) {
  const { wallet } = use(params);

  return (
    <div className="space-y-8 py-8">
      <WalletProfile walletAddress={wallet} />
      <WalletDetail walletAddress={wallet} />
    </div>
  );
}
