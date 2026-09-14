import { readFile } from 'node:fs/promises';
import { validateMatchConfig } from '../src/worker/catalog/config.ts';
import { publishMatchConfig } from '../src/worker/catalog/publish.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';

async function main() {
  const [path, profile, flag, ...extra] = process.argv.slice(2);
  if (
    !path ||
    !profile ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(profile) ||
    (flag && flag !== '--apply') ||
    extra.length
  )
    throw new Error('Usage: pnpm config:apply <config.json> <profile> [--apply]');
  const config = validateMatchConfig(
    JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')),
  );
  if (flag !== '--apply') {
    console.log(JSON.stringify({ profile, config, applied: false }, null, 2));
    return;
  }
  const url = process.env.GAME_CONFIG_DATABASE_URL;
  if (!url) throw new Error('GAME_CONFIG_DATABASE_URL_REQUIRED');
  const { db, close } = connectDatabase(url, process.env.DATABASE_CA_CERT);
  try {
    console.log(JSON.stringify(await publishMatchConfig(db, config, profile)));
  } finally {
    await close();
  }
}
main().catch(() => {
  console.error('CONFIG_APPLY_FAILED: check JSON, DB connection and migration setup.');
  process.exitCode = 1;
});
