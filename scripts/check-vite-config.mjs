import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { localOperationsConfig } from './local-operations-config.ts';

// These are source settings only; checks never deploy or register cloud triggers.
const appWorker = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const erasureWorker = JSON.parse(readFileSync('wrangler.erasure.jsonc', 'utf8'));
assert.deepEqual(appWorker.services, [
  { binding: 'ACCOUNT_ERASURE', service: erasureWorker.name },
]);
assert.equal(erasureWorker.workers_dev, false);
assert.equal(erasureWorker.preview_urls, false);
assert.deepEqual(erasureWorker.routes, []);
assert.deepEqual(erasureWorker.triggers.crons, ['* * * * *']);
for (const binding of erasureWorker.durable_objects.bindings)
  assert.equal(binding.script_name, appWorker.name);

// Evaluate the real Vite config with missing certificate files and stubbed plugins.
const vite = readFileSync('vite.config.ts', 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '')
  .replace('export default defineConfig', 'return defineConfig');

let reads = 0;
let operationsReads = 0;
let pluginOptions;
let operations = { SUPABASE_SECRET_KEY: 'test-secret' };

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
  pluginOptions.auxiliaryWorkers[0].config.vars.SUPABASE_SECRET_KEY,
  'test-secret',
);
assert.equal(pluginOptions.config.vars.SUPABASE_SECRET_KEY, undefined);
assert.equal(pluginOptions.config.services[0].binding, 'ACCOUNT_ERASURE');
operations = undefined;
assert.throws(() => config({ command: 'serve' }), /ENOENT/);
assert.deepEqual(pluginOptions.config.services, []);
assert.deepEqual(pluginOptions.auxiliaryWorkers, []);

// Exercise the real secret/DB/inventory boundary without reading the developer's env files.
const originalDirectory = process.cwd();
mkdirSync('.wrangler', { recursive: true });
const fixture = mkdtempSync(resolve('.wrangler/local-config-check-'));
try {
  process.chdir(fixture);
  assert.equal(localOperationsConfig({}), undefined);
  const runtime = {
    ORGANIZATION_DATABASE_URL:
      'postgres://quiz_organization:test@127.0.0.1:55432/quiz_relay_dev?sslmode=disable',
    SUPABASE_URL: 'https://auth.example.com',
  };
  writeFileSync(
    '.env.erasure-local',
    'ERASURE_DATABASE_URL=postgres://quiz_erasure:test@127.0.0.1:55432/quiz_relay_dev?sslmode=disable\nSUPABASE_URL=https://auth.example.com\nSUPABASE_SECRET_KEY=test-key\n',
  );
  assert.throws(() => localOperationsConfig(runtime), /ENOENT/);
  const rooms = '.wrangler/state/v3/do/quiz-relay-probe-GameRoom';
  mkdirSync(rooms, { recursive: true });
  writeFileSync(`${rooms}/${'b'.repeat(64)}.sqlite`, '');
  writeFileSync(`${rooms}/${'a'.repeat(64)}.sqlite`, '');
  writeFileSync(`${rooms}/${'a'.repeat(64)}.sqlite-wal`, '');
  writeFileSync(`${rooms}/metadata.sqlite`, '');
  assert.deepEqual(JSON.parse(localOperationsConfig(runtime).LOCAL_ROOM_INVENTORY), [
    'a'.repeat(64),
    'b'.repeat(64),
  ]);
  for (const patch of [
    { SUPABASE_URL: 'https://other.example.com' },
    {
      ORGANIZATION_DATABASE_URL: runtime.ORGANIZATION_DATABASE_URL.replace(
        '55432',
        '5432',
      ),
    },
    {
      ORGANIZATION_DATABASE_URL: runtime.ORGANIZATION_DATABASE_URL.replace(
        'postgres:',
        'https:',
      ),
    },
  ])
    assert.throws(
      () => localOperationsConfig({ ...runtime, ...patch }),
      /LOCAL_ERASURE_CONFIGURATION_MISMATCH/,
    );
  writeFileSync(`${rooms}/unknown.sqlite`, '');
  assert.throws(() => localOperationsConfig(runtime), /UNKNOWN_LOCAL_ROOM_FILE/);
  unlinkSync(`${rooms}/unknown.sqlite`);
  writeFileSync(`${rooms}/${'c'.repeat(64)}.sqlite-wal`, '');
  assert.throws(() => localOperationsConfig(runtime), /ORPHANED_LOCAL_ROOM_STATE/);
} finally {
  process.chdir(originalDirectory);
  // This exact temporary directory was created above inside the workspace.
  assert.equal(dirname(fixture), resolve('.wrangler'));
  rmSync(fixture, { recursive: true, force: true });
}

console.log(
  'PASS: private erasure binding/Cron source settings; build excludes dev secrets; local erasure checks DB/Auth and complete room inventory',
);
