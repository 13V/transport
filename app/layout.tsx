import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Solana Insider Tracker',
  description: 'Detect insider wallets, smart money, and bundle activity on Solana tokens',
  icons: {
    icon: '🔍',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body className="bg-gray-950 text-gray-100 font-sans">
        <header className="border-b border-gray-800 bg-gray-900 sticky top-0 z-10">
          <nav className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-2xl">🔍</span>
              <h1 className="text-xl font-bold">Solana Insider Tracker</h1>
            </div>
            <p className="text-sm text-gray-400">
              Detect creators, smart money, and bundle activity
            </p>
          </nav>
        </header>

        <main className="max-w-7xl mx-auto px-4 py-8">
          {children}
        </main>

        <footer className="border-t border-gray-800 bg-gray-900 mt-12 py-6 text-center text-sm text-gray-500">
          <p>Powered by Helius & Solana | Open source insider tracking</p>
        </footer>
      </body>
    </html>
  );
}
