import { spawnSync } from 'node:child_process';

const target = process.argv[2];
if (!['--local', '--remote'].includes(target)) throw new Error('Use --local or --remote');
const result = spawnSync(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'd1',
    'migrations',
    'apply',
    'GAME_D1',
    target,
    '--config',
    'wrangler.jsonc',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_LOG_PATH: '.wrangler/logs/d1-migrations.log' },
  },
);
process.exitCode = result.status ?? 1;
