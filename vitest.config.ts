import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include:
      process.env.GAME_CATALOG_LIVE === '1'
        ? ['tests/catalog.live.ts']
        : ['tests/**/*.test.ts'],
  },
});
