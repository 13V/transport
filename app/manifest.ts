import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Smart Money — Solana wallet analytics',
    short_name: 'Smart Money',
    description:
      'Accurate all-time-ROI smart-money wallet rankings, live buying signals, and funding-cluster analysis on Solana.',
    start_url: '/',
    display: 'standalone',
    background_color: '#090C13',
    theme_color: '#090C13',
    // NOTE: Real icon PNGs (192x192 and 512x512) still need to be added to
    // public/ and referenced here for full installability (home-screen icon).
  };
}
