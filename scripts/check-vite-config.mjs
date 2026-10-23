import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { localOperationsConfig } from './local-operations-config.ts';

// Operator tools run native Node TypeScript, without Vite's module resolver.
await import('../src/worker/scheduled.ts');

// These are source settings only; checks never deploy or register cloud triggers.
const appWorker = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const erasureWorker = JSON.parse(readFileSync('wrangler.erasure.jsonc', 'utf8'));
const qaWorker = JSON.parse(
  readFileSync('config/federation/wrangler.game.jsonc', 'utf8'),
);
for (const worker of [appWorker, qaWorker])
  assert.deepEqual(worker.assets.run_worker_first, ['/api/*', '/federation/v1/*']);
assert.deepEqual(appWorker.services, [
  { binding: 'ACCOUNT_ERASURE', service: erasureWorker.name },
]);
assert.equal(erasureWorker.workers_dev, false);
assert.equal(erasureWorker.preview_urls, false);
assert.deepEqual(erasureWorker.routes, []);
assert.equal(erasureWorker.triggers, undefined);
assert.deepEqual(appWorker.triggers.crons, ['0 * * * *', '0 19 * * *']);
assert.deepEqual(erasureWorker.d1_databases, appWorker.d1_databases);
const qaErasureWorker = JSON.parse(
  readFileSync('config/federation/wrangler.erasure.jsonc', 'utf8'),
);
for (const worker of [appWorker, ...['a', 'b'].map((side) => qaWorker.env[side])]) {
  assert.equal(worker.observability.enabled, true);
  assert.equal(worker.observability.redact_query_string, true);
  assert.deepEqual(worker.observability.logs, {
    enabled: true,
    persist: true,
    head_sampling_rate: 1,
    invocation_logs: false,
  });
}
for (const [main, erasure] of [
  [appWorker, erasureWorker],
  ...['a', 'b'].map((node) => [qaWorker.env[node], qaErasureWorker.env[node]]),
]) {
  assert.deepEqual(
    erasure.ratelimits,
    main.ratelimits.filter((binding) => binding.name === 'FEDERATION_LIMITER'),
  );
  assert.deepEqual(erasure.services, [
    { binding: 'ACCOUNT_ERASURE', service: erasure.name },
  ]);
}

assert.ok(appWorker.d1_databases.some((binding) => binding.binding === 'GAME_D1'));
for (const binding of erasureWorker.durable_objects.bindings)
  assert.equal(binding.script_name, appWorker.name);

// Evaluate the real Vite config with missing certificate files and stubbed plugins.
const vite = readFileSync('vite.config.ts', 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '')
  .replace('export default defineConfig', 'return defineConfig');

let reads = 0;
let operationsReads = 0;
let pluginOptions;
let operations = { CLERK_SECRET_KEY: 'test-secret' };

const config = new Function(
  'existsSync',
  'parseEnv',
  'readFileSync',
  'defineConfig',
  'react',
  'tailwindcss',
  'cloudflare',
  'localOperationsConfig',
  vite,
)(
  () => true,
  () => ({ DEV_TLS_CERT: 'missing-cert', DEV_TLS_KEY: 'missing-key' }),
  (path) => {
    if (path === '.dev.vars') return '';

    reads++;
    throw new Error('ENOENT');
  },
  (value) => value,
  () => ({}),
  () => ({}),
  (options) => {
    pluginOptions = options;
    return {};
  },
  () => {
    operationsReads++;
    return operations;
  },
);

assert.equal(config({ command: 'build' }).server.https, undefined);
assert.equal(reads, 0);
assert.equal(operationsReads, 0);
assert.deepEqual(pluginOptions.auxiliaryWorkers, []);
assert.throws(() => config({ command: 'serve' }), /ENOENT/);
assert.equal(operationsReads, 1);
assert.equal(pluginOptions.auxiliaryWorkers[0].devOnly, true);
assert.equal(
  pluginOptions.auxiliaryWorkers[0].config.vars.CLERK_SECRET_KEY,
  'test-secret',
);
assert.equal(pluginOptions.config.vars.CLERK_SECRET_KEY, undefined);
assert.equal(pluginOptions.config.services[0].binding, 'ACCOUNT_ERASURE');
operations = undefined;
assert.throws(() => config({ command: 'serve' }), /ENOENT/);
assert.deepEqual(pluginOptions.config.services, []);
assert.deepEqual(pluginOptions.auxiliaryWorkers, []);

// Exercise the real secret/DB boundary without reading the developer's env files.
const originalDirectory = process.cwd();
mkdirSync('.wrangler', { recursive: true });
const fixture = mkdtempSync(resolve('.wrangler/local-config-check-'));
try {
  process.chdir(fixture);
  assert.equal(localOperationsConfig({}), undefined);
  const runtime = {
    CLERK_PUBLISHABLE_KEY: 'public-fixture',
    CLERK_SECRET_KEY: 'secret-fixture',
    GAME_CONFIG_PROFILE: 'local',
  };
  writeFileSync(
    '.env.erasure-local',
    'CLERK_PUBLISHABLE_KEY=public-fixture\nCLERK_SECRET_KEY=secret-fixture\n',
  );
  assert.equal(localOperationsConfig(runtime).GAME_CONFIG_PROFILE, 'local');
  for (const patch of [
    { CLERK_PUBLISHABLE_KEY: undefined },
    { CLERK_PUBLISHABLE_KEY: 'other-app' },
    { CLERK_SECRET_KEY: 'other-secret' },
  ])
    assert.throws(
      () => localOperationsConfig({ ...runtime, ...patch }),
      /LOCAL_ERASURE_CONFIGURATION_MISMATCH/,
    );
  assert.throws(
    () => localOperationsConfig({ ...runtime, FEDERATION_ORIGIN: 'https://game.test' }),
    /FEDERATION_NOT_CONFIGURED/,
  );
} finally {
  process.chdir(originalDirectory);
  // This exact temporary directory was created above inside the workspace.
  assert.equal(dirname(fixture), resolve('.wrangler'));
  rmSync(fixture, { recursive: true, force: true });
}

console.log(
  'PASS: private erasure binding/Cron source settings; build excludes dev secrets; local erasure checks Clerk/D1 configuration',
);
