import type { Metadata, Viewport } from 'next';
import './globals.css';
import AppShell from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'Smart Money — Solana wallet analytics',
  description:
    'Accurate all-time-ROI smart-money wallet rankings, live buying signals, and funding-cluster analysis on Solana.',
  applicationName: 'Smart Money',
  openGraph: {
    type: 'website',
    siteName: 'Smart Money',
    title: 'Smart Money — Solana wallet analytics',
    description:
      'Accurate all-time-ROI smart-money wallet rankings, live buying signals, and funding-cluster analysis on Solana.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Smart Money — Solana wallet analytics',
    description:
      'Accurate all-time-ROI smart-money wallet rankings, live buying signals, and funding-cluster analysis on Solana.',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#090C13',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
