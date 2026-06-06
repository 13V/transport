'use client';

import { use } from 'react';
import WalletProfile from '@/components/WalletProfile';

interface WalletDetailPageProps {
  params: Promise<{
    wallet: string;
  }>;
}

export default function WalletDetailPage({ params }: WalletDetailPageProps) {
  const { wallet } = use(params);

  return <WalletProfile walletAddress={wallet} />;
}
