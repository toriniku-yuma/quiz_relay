import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        d1Databases: {
          GAME_D1: 'quiz-relay-isolated-test',
          PEER_D1: 'quiz-relay-peer-isolated-test',
        },
        bindings: {
          D1_MIGRATIONS: await readD1Migrations('./drizzle-d1'),
          // Fixture Clerk keys; tests replace session verification and never use real keys.
          CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
          CLERK_SECRET_KEY: 'sk_test_fixture',
          CLERK_JWT_KEY: '',
        },
        // Tests opt into a private service explicitly; never call the real provider.
        serviceBindings: {
          ACCOUNT_ERASURE: () => {
            throw new Error('ISOLATED_ERASURE_SERVICE_REQUIRED');
          },
        },
      },
    }),
  ],
  test: {
    maxWorkers: 4,
    // D1 migration and 1001-row recovery tests include real storage/RPC work.
    testTimeout: 20000,
    include: ['tests/**/*.test.ts'],
  },
});
