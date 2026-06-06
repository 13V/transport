import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  typescript: {
    tsconfigPath: './tsconfig.json',
  },

  // Performance optimizations
  compress: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,

  // Image optimization
  images: {
    formats: ['image/webp', 'image/avif'],
    deviceSizes: [320, 420, 640, 768, 1024, 1280, 1536],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },

  // Headers for caching
  async headers() {
    return [
      // Per-route Cache-Control is set directly in each /api/smart-money/*
      // route handler (with the correct per-route s-maxage and
      // stale-while-revalidate), so a blanket header rule here would only
      // conflict with those. The previous `source: '/api/smart-money'` rule
      // also matched ONLY the exact path, never the sub-routes — it was a no-op
      // for the routes that actually serve data. Removed as redundant.
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
        ],
      },
    ];
  },

  // Turbopack is enabled by default in Next.js 16
  // No custom webpack config needed
};

export default config;
