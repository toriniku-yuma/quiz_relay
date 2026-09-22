import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { and, asc, eq, sql } from 'drizzle-orm';
import defaults from '../config/matchmaking.json' with { type: 'json' };
import type { FixedQuestion } from '../src/worker/catalog/definition.ts';
import {
  authorizeCatalog,
  listCatalog,
  manageCatalog,
} from '../src/worker/catalog/manage.ts';
import { publishMatchConfig } from '../src/worker/catalog/publish.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';
import {
  questionAvailability as a,
  catalogOperators,
  questionSetItems as i,
  matchResults,
  questionVersions as q,
  rulesetVersions as r,
  questionSets as s,
} from '../src/worker/db/schema.ts';

async function main() {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const rollback = new Error('CATALOG_TEST_ROLLBACK');
  if (process.argv.includes('--ddl-only')) {
    if (!process.env.GAME_MIGRATION_DATABASE_URL) throw new Error('ADMIN_REQUIRED');
    const admin = connectDatabase(
      process.env.GAME_MIGRATION_DATABASE_URL,
      process.env.DATABASE_CA_CERT,
    );
    try {
      const journal = JSON.parse(
        await readFile('drizzle/meta/_journal.json', 'utf8'),
      ) as { entries: { tag: string }[] };
      await assert.rejects(
        admin.db.transaction(async (tx) => {
          for (const { tag } of journal.entries) {
            let source = await readFile(`drizzle/${tag}.sql`, 'utf8');
            for (const [name, prefix] of Object.entries({
              quiz_game_reader: 'qr',
              quiz_game_config: 'qc',
              quiz_game_results: 'qres',
              quiz_game_catalog: 'qcat',
              quiz_game: 'qgame',
              quiz_probe: 'qprobe',
            }))
              source = source.replace(
                new RegExp(`\\b${name}\\b`, 'g'),
                `${prefix}_${suffix}`,
              );
            for (const statement of source.split('--> statement-breakpoint'))
              if (statement.trim()) await tx.execute(sql.raw(statement));
          }
          throw rollback;
        }),
        (error) => error === rollback,
      );
      console.log(
        'PASS: all catalog migrations applied in isolated transaction and rolled back',
      );
    } finally {
      await admin.close();
    }
    return;
  }
  const owner = process.env.GAME_OWNER ?? defaults.owner;
  if (!owner || !process.env.GAME_CATALOG_DATABASE_URL)
    throw new Error('CATALOG_CONFIG_REQUIRED');
  const writer = connectDatabase(
    process.env.GAME_CATALOG_DATABASE_URL,
    process.env.DATABASE_CA_CERT,
  );
  const secondWriter = connectDatabase(
    process.env.GAME_CATALOG_DATABASE_URL,
    process.env.DATABASE_CA_CERT,
  );
  const reader = connectDatabase(
    process.env.GAME_DATABASE_URL ?? '',
    process.env.DATABASE_CA_CERT,
  );
  const seed = JSON.parse(
    await readFile('supabase/seeds/mock-hiragana.json', 'utf8'),
  ) as FixedQuestion[];
  const config = JSON.parse(await readFile('config/matchmaking.local.json', 'utf8'));
  const id = `qa_${suffix}`;
  const denied = (error: unknown) => {
    const item = error as { code?: string; cause?: { code?: string } };
    return (item.cause?.code ?? item.code) === '42501';
  };
  try {
    await assert.rejects(
      writer.db.transaction(async (tx) => {
        await authorizeCatalog(tx, owner);
        const question = { ...seed[0], id };
        const register = { operation: 'register', question };
        assert.deepEqual(
          await manageCatalog(tx, owner, register),
          await manageCatalog(tx, owner, register),
        );
        await assert.rejects(
          manageCatalog(tx, owner, {
            ...register,
            question: { ...question, text: 'conflict' },
          }),
          /QUESTION_ID_CONFLICT/,
        );
        await secondWriter.db.transaction(async (other) => {
          const [lock] = await other.execute(
            sql`select pg_try_advisory_xact_lock(hashtextextended(${owner}, 0)) as acquired`,
          );
          assert.equal(lock.acquired, false);
        });
        const set = { operation: 'set', setId: id, questionIds: [id] };
        const firstSet = await manageCatalog(tx, owner, set);
        assert.deepEqual(firstSet, await manageCatalog(tx, owner, set));
        const fixed = {
          ...config,
          owner,
          competitionId: id,
          rulesetId: id,
          questionSet: { id, version: 1 },
        };
        const firstConfig = await manageCatalog(tx, owner, {
          operation: 'configure',
          profile: id,
          config: fixed,
        });
        assert.deepEqual(
          firstConfig,
          await manageCatalog(tx, owner, {
            operation: 'configure',
            profile: id,
            config: fixed,
          }),
        );
        const before = await tx
          .select()
          .from(q)
          .where(and(eq(q.owner, owner), eq(q.questionId, id)));
        const revise = {
          operation: 'revise',
          questionId: id,
          question: { ...question, id: `${id}_new`, text: '改訂した問題です。' },
        };
        assert.deepEqual(
          await manageCatalog(tx, owner, revise),
          await manageCatalog(tx, owner, revise),
        );
        assert.deepEqual(
          await tx
            .select()
            .from(q)
            .where(and(eq(q.owner, owner), eq(q.questionId, id))),
          before,
        );
        assert.ok(
          (
            await tx
              .select()
              .from(a)
              .where(and(eq(a.owner, owner), eq(a.questionId, id)))
          )[0].retiredAt,
        );
        assert.equal(
          (
            await tx
              .select()
              .from(i)
              .where(and(eq(i.owner, owner), eq(i.setId, id), eq(i.setVersion, 1)))
          )[0].questionId,
          id,
        );
        await assert.rejects(publishMatchConfig(tx, fixed, id), /QUESTION_UNAVAILABLE/);
        await assert.rejects(manageCatalog(tx, owner, set), /QUESTION_UNAVAILABLE/);
        await manageCatalog(tx, owner, {
          operation: 'register',
          question: { ...question, id: `${id}_extra` },
        });
        const secondSet = await manageCatalog(tx, owner, {
          ...set,
          questionIds: [`${id}_extra`, `${id}_new`],
        });
        assert.deepEqual(
          (
            await tx
              .select()
              .from(i)
              .where(and(eq(i.owner, owner), eq(i.setId, id), eq(i.setVersion, 2)))
              .orderBy(asc(i.ordinal))
          ).map((item) => item.questionId),
          [`${id}_extra`, `${id}_new`],
        );
        assert.equal('version' in secondSet && secondSet.version, 2);
        const modified = {
          ...fixed,
          playersPerMatch: 3,
          questionSet: { id, version: 2 },
          rules: { ...fixed.rules, correctAnswersToWin: 5 },
        };
        const secondConfig = await manageCatalog(tx, owner, {
          operation: 'configure',
          profile: id,
          config: modified,
        });
        assert.equal('version' in secondConfig && secondConfig.version, 2);
        assert.equal(
          (
            await tx
              .select()
              .from(r)
              .where(and(eq(r.owner, owner), eq(r.rulesetId, id), eq(r.version, 1)))
          )[0].config.correctAnswersToWin,
          fixed.rules.correctAnswersToWin,
        );
        await manageCatalog(tx, owner, {
          operation: 'register',
          question: { ...question, id: `${id}_source` },
        });
        await tx.insert(a).values({ owner, questionId: `${id}_collision` });
        await assert.rejects(
          manageCatalog(tx, owner, {
            operation: 'revise',
            questionId: `${id}_source`,
            question: { ...question, id: `${id}_collision` },
          }),
        );
        assert.equal(
          (
            await tx
              .select()
              .from(q)
              .where(and(eq(q.owner, owner), eq(q.questionId, `${id}_collision`)))
          ).length,
          0,
        );
        assert.equal(
          (
            await tx
              .select()
              .from(a)
              .where(and(eq(a.owner, owner), eq(a.questionId, `${id}_source`)))
          )[0].retiredAt,
          null,
        );
        const listing = await listCatalog(tx, owner);
        assert.equal(listing.sets.filter((item) => item.setId === id).length, 2);
        await manageCatalog(tx, owner, { operation: 'retire', questionId: `${id}_new` });
        await manageCatalog(tx, owner, { operation: 'retire', questionId: `${id}_new` });
        await assert.rejects(
          manageCatalog(tx, owner, { ...set, questionIds: [`${id}_new`] }),
          /QUESTION_UNAVAILABLE/,
        );
        await assert.rejects(
          manageCatalog(tx, 'https://other.invalid', register),
          /CATALOG_FORBIDDEN/,
        );
        await assert.rejects(
          tx.transaction((nested) =>
            nested.insert(a).values({ owner: 'https://other.invalid', questionId: id }),
          ),
          denied,
        );
        await assert.rejects(
          tx.transaction((nested) =>
            nested.update(q).set({ payload: question }).where(eq(q.questionId, id)),
          ),
          denied,
        );
        await assert.rejects(
          tx.transaction((nested) => nested.delete(q).where(eq(q.questionId, id))),
          denied,
        );
        await assert.rejects(
          tx.transaction((nested) => nested.select().from(matchResults).limit(1)),
          denied,
        );
        await assert.rejects(
          tx.transaction((nested) =>
            nested.update(catalogOperators).set({ owner: 'https://other.invalid' }),
          ),
          denied,
        );
        throw rollback;
      }),
      (error) => error === rollback,
    );
    assert.equal((await writer.db.select().from(s).where(eq(s.setId, id))).length, 0);
    await assert.rejects(authorizeCatalog(reader.db, owner), denied);
    console.log(
      'PASS: register/revise/retire, repeat, immutable versions, ordered sets, config switching, owner RLS and role restrictions; all test records rolled back',
    );
  } finally {
    await Promise.all([writer.close(), reader.close(), secondWriter.close()]);
  }
}
main().catch((error) => {
  console.error('CATALOG_CHECK_FAILED', error?.cause?.code ?? error?.code ?? 'NO_CODE');
  if (error?.code === 'ERR_ASSERTION') console.error(error.message);
  process.exitCode = 1;
});
