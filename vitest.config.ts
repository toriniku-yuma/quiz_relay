import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import {
  unstable_readConfig as readWranglerConfig,
  unstable_getDurableObjectClassNameToUseSQLiteMap as sqliteDurableObjectClasses,
} from 'wrangler';

// Loading wrangler.jsonc through the plugin also reads a developer's .dev.vars.
// Tests take the Worker shape from wrangler.jsonc and every value from the bindings below.
const worker = readWranglerConfig({ config: './wrangler.jsonc' });
const sqliteClasses = sqliteDurableObjectClasses(worker.migrations, worker.exports);

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: worker.main,
      miniflare: {
        compatibilityDate: worker.compatibility_date,
        compatibilityFlags: worker.compatibility_flags,
        durableObjects: Object.fromEntries(
          worker.durable_objects.bindings.map(
            (binding: { name: string; class_name: string }) => [
              binding.name,
              {
                className: binding.class_name,
                useSQLite: sqliteClasses.get(binding.class_name) === true,
              },
            ],
          ),
        ),
        ratelimits: Object.fromEntries(
          worker.ratelimits.map(
            (limiter: {
              name: string;
              namespace_id: string;
              simple: { limit: number; period: 10 | 60 };
            }) => [
              limiter.name,
              { namespace_id: limiter.namespace_id, simple: limiter.simple },
            ],
          ),
        ),
        d1Databases: {
          GAME_D1: 'quiz-relay-isolated-test',
          PEER_D1: 'quiz-relay-peer-isolated-test',
        },
        bindings: {
          ...worker.vars,
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
