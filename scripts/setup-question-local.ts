import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { provisionLocalQuestionPermissions } from './question-local-permissions.ts';

const address = parseEnv(
  readFileSync('.env.postgres-local', 'utf8'),
).GAME_MIGRATION_DATABASE_URL;
if (!address) throw new Error('LOCAL_DATABASE_NOT_CONFIGURED');
const target = new URL(address);
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.port, '55432');
assert.equal(target.pathname, '/quiz_relay_dev');
const backups = resolve('.wrangler/postgres-dev/backups');
mkdirSync(backups, { recursive: true });
const backup = resolve(backups, `before-questions-${Date.now()}.dump`);
execFileSync(
  resolve('.wrangler/pg-local/pgsql/bin/pg_dump.exe'),
  [
    '-h',
    target.hostname,
    '-p',
    target.port,
    '-U',
    target.username,
    '-d',
    'quiz_relay_dev',
    '-Fc',
    '-f',
    backup,
  ],
  {
    windowsHide: true,
    timeout: 60000,
    stdio: 'ignore',
    env: { ...process.env, PGPASSWORD: decodeURIComponent(target.password) },
  },
);
const client = postgres(address, { ssl: false, max: 1 });
try {
  const db = drizzle(client);
  {
    const tx = db;
    // Reconcile policies created by the earlier local-only verifier before generated DDL.
    for (const name of [
      'question_review_cases',
      'question_reports',
      'question_difficulty',
    ]) {
      const existing = await tx.execute(
        sql`select to_regclass(${`quiz_game.${name}`}) as relation`,
      );
      if (existing[0]?.relation)
        await tx.execute(
          sql.raw(`DROP POLICY IF EXISTS organization_service ON quiz_game.${name}`),
        );
    }
    try {
      await migrate(db, { migrationsFolder: 'drizzle' });
    } finally {
      await provisionLocalQuestionPermissions(db, address);
    }
  }
  console.log(`Local question schema ready; backup: ${backup}`);
} finally {
  await client.end();
}
