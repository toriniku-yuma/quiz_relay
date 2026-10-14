import { readFile } from 'node:fs/promises';
import { validateMatchConfig } from '../src/worker/catalog/config.ts';
import { authorizeCatalog } from '../src/worker/catalog/manage.ts';
import { publishMatchConfig } from '../src/worker/catalog/publish.ts';
import { localD1 } from './local-d1.ts';

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
  const subject = process.env.CATALOG_SUBJECT;
  if (!subject) throw new Error('CATALOG_SUBJECT_REQUIRED');
  const { db, close } = await localD1();
  try {
    console.log(
      JSON.stringify(
        await publishMatchConfig(db, config, profile, () =>
          authorizeCatalog(db, config.owner, subject),
        ),
      ),
    );
  } finally {
    await close();
  }
}
main().catch((error) => {
  console.error(
    error?.message === 'CATALOG_SUBJECT_REQUIRED'
      ? 'CATALOG_SUBJECT_REQUIRED: set CATALOG_SUBJECT in .dev.vars.'
      : 'CONFIG_APPLY_FAILED: check JSON, DB connection and migration setup.',
  );
  process.exitCode = 1;
});
