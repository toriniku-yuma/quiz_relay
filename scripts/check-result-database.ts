import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { and, count, eq, sql } from 'drizzle-orm';
import { connectDatabase } from '../src/worker/db/connection.ts';
import { matchResults, resultOutbox, resultPlayers } from '../src/worker/db/schema.ts';
import { rules } from '../src/worker/game/rules.ts';
import { commitResult, ResultConflict } from '../src/worker/results/database.ts';
import { readResults } from '../src/worker/results/read.ts';
import type { ResultRecord } from '../src/worker/results/record.ts';

async function main() {
  const url = process.env.GAME_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('ADMIN_REQUIRED');
  const admin = connectDatabase(url, process.env.DATABASE_CA_CERT);
  const writer = connectDatabase(
    process.env.RESULT_DATABASE_URL ?? url,
    process.env.DATABASE_CA_CERT,
  );
  const reader = connectDatabase(
    process.env.GAME_DATABASE_URL ?? url,
    process.env.DATABASE_CA_CERT,
  );
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const rollback = new Error('ROLLBACK_TEST');
  try {
    if (process.argv.includes('--ddl-only')) {
      const schema = `qa_results_${suffix}`;
      const role = `qa_result_writer_${suffix}`;
      await assert.rejects(
        admin.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`CREATE SCHEMA ${schema}`));
          const security = (
            await readFile('drizzle/0001_existing_security.sql', 'utf8')
          ).split('--> statement-breakpoint')[0];
          await tx.execute(sql.raw(security.replaceAll('quiz_game.', `${schema}.`)));
          for (const file of [
            '0005_result_writer.sql',
            '0006_match_results.sql',
            '0007_result_permissions.sql',
          ]) {
            const source = (await readFile(`drizzle/${file}`, 'utf8'))
              .replaceAll('quiz_game_results', role)
              .replaceAll('quiz_game.', `${schema}.`)
              .replaceAll('"quiz_game"', `"${schema}"`)
              .replaceAll('SCHEMA quiz_game ', `SCHEMA ${schema} `);
            for (const statement of source.split('--> statement-breakpoint'))
              if (statement.trim()) await tx.execute(sql.raw(statement));
          }
          throw rollback;
        }),
        (error) => error === rollback,
      );
      console.log('PASS: isolated result migrations rolled back');
      return;
    }
    const owner = `https://qa-${suffix}.invalid`;
    const record: ResultRecord = {
      version: 1,
      owner,
      matchId: crypto.randomUUID(),
      kind: 'ranked',
      startedAt: 1000,
      result: {
        id: crypto.randomUUID(),
        winnerId: 'a',
        reason: 'target_reached',
        finishedAt: 2000,
      },
      ratingVersion: 1,
      definition: {
        competition: { owner, id: 'qa', version: 1 },
        ruleset: { owner, id: 'qa', version: 1 },
        questionSet: { owner, id: 'qa', version: 1 },
        rules: { ...rules, showSelections: true },
        rulesHash: 'a'.repeat(64),
        manifestHash: 'b'.repeat(64),
        playersPerMatch: 2,
      },
      players: ['a', 'b'].map((id) => ({
        id,
        name: id.toUpperCase(),
        correct: id === 'a' ? 7 : 0,
        mistakes: 0,
        connected: true,
        disqualified: false,
        locked: false,
        ratingDelta: id === 'a' ? 20 : -20,
      })),
    };
    record.owner = owner;
    record.definition.competition.owner = owner;
    record.definition.ruleset.owner = owner;
    record.definition.questionSet.owner = owner;
    // 一意な検証専用owner。実commit済み原本は不変保護を維持して残す。
    await commitResult(writer.db, record);
    const second = connectDatabase(
      process.env.RESULT_DATABASE_URL ?? url,
      process.env.DATABASE_CA_CERT,
    );
    try {
      await Promise.all([
        commitResult(writer.db, record),
        commitResult(second.db, record),
      ]);
      const [saved] = await second.db
        .select({ n: count() })
        .from(matchResults)
        .where(eq(matchResults.resultId, record.result.id));
      const [outbox] = await second.db
        .select({ n: count() })
        .from(resultOutbox)
        .where(eq(resultOutbox.resultId, record.result.id));
      assert.equal(saved.n, 1);
      assert.equal(outbox.n, 1);
    } finally {
      await second.close();
    }
    await assert.rejects(
      commitResult(writer.db, { ...record, startedAt: 999 }),
      ResultConflict,
    );
    const sameMatch = structuredClone(record);
    sameMatch.result.id = crypto.randomUUID();
    await assert.rejects(commitResult(writer.db, sameMatch), ResultConflict);

    const invalid = structuredClone(record);
    invalid.result.id = crypto.randomUUID();
    invalid.matchId = crypto.randomUUID();
    invalid.players = [invalid.players[0], invalid.players[0]];
    await assert.rejects(commitResult(writer.db, invalid));
    assert.equal(
      (
        await admin.db
          .select()
          .from(matchResults)
          .where(eq(matchResults.resultId, invalid.result.id))
      ).length,
      0,
    );
    assert.equal(
      (
        await admin.db
          .select()
          .from(resultOutbox)
          .where(eq(resultOutbox.resultId, invalid.result.id))
      ).length,
      0,
    );
    const overview = await readResults(reader.db, owner, 'a');
    assert.deepEqual(
      overview.ranking.map((r) => [r.actorId, r.rating, r.rank]),
      [
        ['a', 1020, 1],
        ['b', 980, 2],
      ],
    );
    assert.equal(overview.history.length, 1);
    const casual = structuredClone(record);
    casual.kind = 'casual';
    casual.result.id = crypto.randomUUID();
    casual.matchId = crypto.randomUUID();
    casual.players = casual.players.map((p) => ({ ...p, ratingDelta: 0 }));
    await commitResult(writer.db, casual);
    assert.deepEqual(
      (await readResults(reader.db, owner, 'a')).ranking,
      overview.ranking,
    );
    assert.equal(
      (await readResults(reader.db, 'https://unrelated.invalid', 'a')).history.length,
      0,
    );

    const tied = structuredClone(record);
    tied.result.id = crypto.randomUUID();
    tied.matchId = crypto.randomUUID();
    tied.players = [
      { ...record.players[0], id: 'c', name: 'C' },
      { ...record.players[1], id: 'd', name: 'D' },
    ];
    tied.result.winnerId = 'c';
    await commitResult(writer.db, tied);
    assert.deepEqual(
      (await readResults(reader.db, owner, 'a')).ranking.map((r) => r.rank),
      [1, 1, 3, 3],
    );

    const denied = (error: unknown) => {
      const value = error as { code?: string; cause?: { code?: string } };
      return (value.cause?.code ?? value.code) === '42501';
    };
    for (const connection of [reader, writer]) {
      await assert.rejects(
        connection.db
          .update(matchResults)
          .set({ payloadHash: 'c'.repeat(64) })
          .where(eq(matchResults.resultId, record.result.id)),
        denied,
      );
    }
    await assert.rejects(
      admin.db
        .update(matchResults)
        .set({ payloadHash: 'c'.repeat(64) })
        .where(eq(matchResults.resultId, record.result.id)),
    );
    await assert.rejects(
      writer.db.transaction(async (tx) => {
        await commitResult(tx, record);
        const test = structuredClone(record);
        test.result.id = crypto.randomUUID();
        test.matchId = crypto.randomUUID();
        await commitResult(tx, test);
        throw rollback;
      }),
      (error) => error === rollback,
    );
    await assert.rejects(reader.db.select().from(resultOutbox), denied);
    await assert.rejects(
      reader.db.insert(resultPlayers).values({
        resultId: record.result.id,
        actorId: 'forbidden',
        name: 'Forbidden',
        ratingDelta: 20,
      }),
      denied,
    );
    for (const role of ['anon', 'authenticated']) {
      const [permissions] = await admin.db.execute(
        sql`SELECT has_schema_privilege(${role}::text, 'quiz_game', 'USAGE') AS access`,
      );
      assert.equal(permissions.access, false);
    }
    assert.equal(
      (
        await admin.db
          .select()
          .from(resultPlayers)
          .where(
            and(
              eq(resultPlayers.resultId, record.result.id),
              eq(resultPlayers.actorId, 'a'),
            ),
          )
      ).length,
      1,
    );
    console.log(
      'PASS: actual commit, concurrent retry, conflict, atomic rollback, rating ties, casual exclusion and role permissions',
    );
    console.log(`Isolated verification owner: ${owner}`);
  } finally {
    await Promise.all([admin.close(), writer.close(), reader.close()]);
  }
}
main().catch((error) => {
  console.error('Failure code:', error?.cause?.code ?? error?.code ?? 'NO_CODE');
  if (error?.code === 'ERR_ASSERTION') console.error('Assertion:', error.message);
  console.error('RESULT_DATABASE_CHECK_FAILED');
  process.exitCode = 1;
});
