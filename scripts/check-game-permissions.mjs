import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { boolean, integer, pgSchema, text } from 'drizzle-orm/pg-core';
import { connectDatabase } from '../src/worker/db/connection.ts';
import { questionVersions, rulesetVersions } from '../src/worker/db/schema.ts';

if (!process.env.GAME_MIGRATION_DATABASE_URL)
  throw new Error('MIGRATION_DATABASE_REQUIRED');
const { db, close } = connectDatabase(
  process.env.GAME_MIGRATION_DATABASE_URL,
  process.env.DATABASE_CA_CERT,
);
// PostgreSQL system catalogs/functions inspect DB enforcement, not just the TS schema.
const catalog = pgSchema('pg_catalog');
const tables = catalog.table('pg_class', {
  name: text('relname'),
  namespace: integer('relnamespace'),
  kind: text('relkind'),
  rls: boolean('relrowsecurity'),
});
const namespaces = catalog.table('pg_namespace', {
  id: integer('oid'),
  name: text('nspname'),
});
const code = (error) => error.cause?.code ?? error.code;
try {
  for (const role of ['anon', 'authenticated', 'quiz_game_reader']) {
    const rows = await db
      .select({
        name: tables.name,
        kind: tables.kind,
        rls: tables.rls,
        schemaUsage: sql`has_schema_privilege(${role}, 'quiz_game', 'USAGE')`,
        canRead: sql`has_table_privilege(${role}, 'quiz_game.' || ${tables.name}, 'SELECT')`,
        canWrite: sql`has_table_privilege(${role}, 'quiz_game.' || ${tables.name}, 'INSERT,UPDATE,DELETE,TRUNCATE')`,
      })
      .from(tables)
      .innerJoin(namespaces, eq(namespaces.id, tables.namespace))
      .where(eq(namespaces.name, 'quiz_game'));
    const actualTables = rows.filter((row) => row.kind === 'r');
    assert.equal(actualTables.length, 7);
    for (const row of actualTables) {
      assert.equal(row.rls, true);
      assert.equal(row.schemaUsage, role === 'quiz_game_reader');
      assert.equal(row.canRead, role === 'quiz_game_reader');
      assert.equal(row.canWrite, false);
    }
  }
  // Role selection has no query-builder API; fixed statements, no input interpolation.
  for (const statement of [sql`set local role anon`, sql`set local role authenticated`]) {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(statement);
        await tx
          .select({ payload: questionVersions.payload })
          .from(questionVersions)
          .limit(1);
      }),
      (error) => code(error) === '42501',
    );
  }
  const rollback = new Error('PERMISSION_TEST_ROLLBACK');
  await assert.rejects(
    db.transaction(async (tx) => {
      const owner = `https://qa-${crypto.randomUUID()}.invalid`;
      const record = {
        owner,
        rulesetId: 'test',
        version: 1,
        rulesHash: '0'.repeat(64),
        config: {},
      };
      await tx.insert(rulesetVersions).values(record);
      await assert.rejects(
        tx.transaction((nested) =>
          nested
            .update(rulesetVersions)
            .set({ version: 1 })
            .where(eq(rulesetVersions.owner, owner)),
        ),
        (error) => (error.cause?.message ?? error.message) === 'IMMUTABLE_VERSION',
      );
      await assert.rejects(
        tx.transaction((nested) =>
          nested.delete(rulesetVersions).where(eq(rulesetVersions.owner, owner)),
        ),
        (error) => (error.cause?.message ?? error.message) === 'IMMUTABLE_VERSION',
      );
      await assert.rejects(
        tx.transaction((nested) => nested.insert(rulesetVersions).values(record)),
        (error) => code(error) === '23505',
      );
      throw rollback;
    }),
    (error) => error === rollback,
  );
  console.log(
    'PASS: all catalog RLS/grants, anon/authenticated read denial, immutable update/delete and duplicate rejection; rolled back',
  );
} catch {
  console.error('GAME_PERMISSIONS_CHECK_FAILED');
  process.exitCode = 1;
} finally {
  await close();
}
