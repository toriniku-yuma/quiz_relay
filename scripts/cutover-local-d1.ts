import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { is, sql } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../src/worker/db/schema.ts';
import {
  installPostgresCopy,
  type SourceTable,
  verifyPostgresCopy,
} from './legacy-postgres/copy.ts';
import { localD1 } from './local-d1.ts';

try {
  const [input, flag, ...extra] = process.argv.slice(2),
    root = resolve('.wrangler/d1-migration'),
    directory = resolve(input ?? '');
  if (flag !== '--apply' || extra.length || !directory.startsWith(root + sep))
    throw new Error('VERIFIED_LOCAL_BACKUP_REQUIRED');
  const backup = readFileSync(resolve(directory, 'backup.json')),
    expected = readFileSync(resolve(directory, 'backup.sha256'), 'utf8').trim();
  const hash = createHash('sha256').update(backup).digest('hex');
  if (hash !== expected) throw new Error('BACKUP_HASH_MISMATCH');
  const report = JSON.parse(
    readFileSync(resolve(directory, 'verification.json'), 'utf8'),
  );
  if (
    report.backupHash !== hash ||
    report.sourceModified !== false ||
    report.integrity !== 'ok' ||
    report.cutover !== false
  )
    throw new Error('BACKUP_VERIFICATION_REQUIRED');
  const source = JSON.parse(backup.toString()) as {
    version: number;
    tables: SourceTable[];
  };
  if (source.version !== 1) throw new Error('SOURCE_VERSION_MISMATCH');
  const target = await localD1();
  try {
    for (const [name, table] of Object.entries(schema)) {
      if (!is(table, SQLiteTable) || name === 'databaseRevision') continue;
      const [row] = await target.db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(table);
      if (row.count) throw new Error('LOCAL_D1_MUST_BE_EMPTY');
    }
    const state = resolve(directory, 'runtime-before-cutover');
    mkdirSync(state, { recursive: false });
    for (const file of [
      '.dev.vars',
      '.env.erasure-local',
      'wrangler.jsonc',
      'wrangler.erasure.jsonc',
    ])
      if (existsSync(file)) copyFileSync(file, resolve(state, file));
    // Preserve the complete original DO directory, including WAL files, while the app is stopped.
    if (existsSync('.wrangler/state/v3/do'))
      cpSync('.wrangler/state/v3/do', resolve(state, 'do'), { recursive: true });
    const plan = await installPostgresCopy(target.db, source.tables),
      verified = await verifyPostgresCopy(target.db, plan);
    writeFileSync(
      resolve(directory, 'cutover.json'),
      JSON.stringify(
        { ...verified, backupHash: hash, sourceModified: false, cutover: true },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        ...verified,
        backupVerified: true,
        copyVerified: true,
        sourceModified: false,
        cutover: true,
      }),
    );
  } finally {
    await target.close();
  }
} catch (error) {
  writeFileSync(
    '.wrangler/d1-cutover-failure.txt',
    error instanceof Error
      ? `${error.stack}\n${error.cause instanceof Error ? error.cause.stack : ''}`
      : String(error),
  );
  const code =
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : 'LOCAL_D1_CUTOVER_FAILED';
  console.error(code);
  process.exitCode = 1;
}
