import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import defaults from '../config/matchmaking.json' with { type: 'json' };
import { validateRef } from '../src/worker/catalog/definition.ts';
import { authorizeCatalog } from '../src/worker/catalog/manage.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';
import { catalogOperators } from '../src/worker/db/schema.ts';

async function main() {
  if (process.argv.slice(2).join(',') !== '--apply') throw new Error('APPLY_REQUIRED');
  const owner = validateRef({
    owner: process.env.GAME_OWNER ?? defaults.owner,
    id: 'owner',
    version: 1,
  }).owner;
  if (process.env.GAME_CATALOG_DATABASE_URL) {
    const existing = connectDatabase(
      process.env.GAME_CATALOG_DATABASE_URL,
      process.env.DATABASE_CA_CERT,
    );
    try {
      await authorizeCatalog(existing.db, owner);
    } finally {
      await existing.close();
    }
    console.log('Existing catalog operator verified; credentials preserved');
    return;
  }
  if (!process.env.GAME_DATABASE_URL || !process.env.GAME_MIGRATION_DATABASE_URL)
    throw new Error('CONFIG_REQUIRED');
  const url = new URL(process.env.GAME_DATABASE_URL);
  if (!decodeURIComponent(url.username).startsWith('quiz_game_reader'))
    throw new Error('UNEXPECTED_READER');
  const password = Array.from(randomBytes(32), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  url.username = decodeURIComponent(url.username).replace(
    'quiz_game_reader',
    'quiz_game_catalog',
  );
  url.password = password;
  const admin = connectDatabase(
    process.env.GAME_MIGRATION_DATABASE_URL,
    process.env.DATABASE_CA_CERT,
  );
  try {
    await admin.db.transaction(async (tx) => {
      await tx
        .insert(catalogOperators)
        .values({ roleName: 'quiz_game_catalog', owner })
        .onConflictDoNothing();
      const [existing] = await tx
        .select()
        .from(catalogOperators)
        .where(eq(catalogOperators.roleName, 'quiz_game_catalog'));
      if (existing?.owner !== owner) throw new Error('OWNER_MISMATCH');
      // ROLEの資格情報設定はPostgreSQL固有DDL。値の引用はDBのformat(%L)で行う。
      const rows = await tx.execute(
        sql`SELECT format('ALTER ROLE quiz_game_catalog PASSWORD %L', ${password}::text) AS command`,
      );
      await tx.execute(sql.raw(String(rows[0].command)));
    });
  } finally {
    await admin.close();
  }
  const operator = connectDatabase(url.href, process.env.DATABASE_CA_CERT);
  try {
    await authorizeCatalog(operator.db, owner);
  } finally {
    await operator.close();
  }
  await appendFile('.env.supabase-admin', `\nGAME_CATALOG_DATABASE_URL=${url.href}\n`);
  console.log('Catalog operator bound to owner, verified and stored locally');
}
main().catch(() => {
  console.error('CATALOG_SETUP_FAILED: check owner, migrations and local credentials.');
  process.exitCode = 1;
});
