import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = readdirSync('tests')
  .filter((name) => /^d1-.*\.test\.ts$/.test(name))
  .map((name) => `tests/${name}`);
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    ...files,
    '--maxWorkers=1',
    '--testTimeout=30000',
    '--hookTimeout=30000',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_LOG_PATH: '.wrangler/logs/d1-tests.log' },
  },
);
process.exitCode = result.status ?? 1;
