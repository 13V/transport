'use client';

import { ExternalLink } from 'lucide-react';

interface ExternalLinksProps {
  mint: string;
  address?: string;
  symbol?: string;
}

export default function ExternalLinks({ mint, address, symbol }: ExternalLinksProps) {
  const links = address ? [
    {
      name: 'Solscan',
      url: `https://solscan.io/address/${address}`,
      icon: '🔍',
    },
    {
      name: 'Magic Eden',
      url: `https://magiceden.io/creators/${address}`,
      icon: '✨',
    },
    {
      name: 'Helius',
      url: `https://app.helius.dev/?key=${address}`,
      icon: '⛓️',
    },
  ] : [
    {
      name: 'DEXScreener',
      url: `https://dexscreener.com/solana/${mint}`,
      icon: '📊',
    },
    {
      name: 'Birdeye',
      url: `https://birdeye.so/token/${mint}`,
      icon: '🦅',
    },
    {
      name: 'Jupiter',
      url: `https://jup.ag/swap/USDC-${mint}`,
      icon: '🪐',
    },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {links.map((link) => (
        <a
          key={link.name}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-sm text-blue-400 hover:text-blue-300 transition-colors"
          title={`View on ${link.name}`}
        >
          <span>{link.icon}</span>
          {link.name}
          <ExternalLink className="w-3 h-3 ml-1" />
        </a>
      ))}
    </div>
  );
}
