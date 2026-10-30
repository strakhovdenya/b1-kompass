import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const repoRoot = path.join(import.meta.dirname, '..', '..');

const nextConfig: NextConfig = {
  transpilePackages: ['@b1k/domain'],
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Guest pages carry personal answers: never store them in a shared
        // cache.
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
