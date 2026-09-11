import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Evaluate the real Vite config with missing certificate files and stubbed plugins.
const vite = readFileSync('vite.config.ts', 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '')
  .replace('export default defineConfig', 'return defineConfig');

let reads = 0;

const config = new Function(
  'existsSync',
  'parseEnv',
  'readFileSync',
  'defineConfig',
  'react',
  'tailwindcss',
  'cloudflare',
  vite,
)(
  () => true,
  () => ({ DEV_TLS_CERT: 'missing-cert', DEV_TLS_KEY: 'missing-key' }),
  (path) => {
    if (path === '.dev.vars') return '';

    reads++;
    throw new Error('ENOENT');
  },
  (x) => x,
  () => ({}),
  () => ({}),
  () => ({}),
);

assert.equal(config({ command: 'build' }).server.https, undefined);
assert.equal(reads, 0);
assert.throws(() => config({ command: 'serve' }), /ENOENT/);

console.log('PASS: build does not read development TLS files; serve checks them');
