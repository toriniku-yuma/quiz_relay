import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Real erasure runs only in check-erasure-service.ts with isolated DB/Auth fixtures.
        serviceBindings: {
          ACCOUNT_ERASURE: () => {
            throw new Error('ISOLATED_ERASURE_SERVICE_REQUIRED');
          },
        },
      },
    }),
  ],
  test: {
    include:
      process.env.GAME_CATALOG_LIVE === '1'
        ? ['tests/catalog.live.ts']
        : ['tests/**/*.test.ts'],
  },
});
