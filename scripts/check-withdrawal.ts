import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eraseAuthentication } from '../src/erasure/jobs.ts';
import { eraseResultNames } from '../src/erasure/results.ts';
import { anonymizeWithdrawal } from '../src/erasure/withdrawals.ts';
import { contentHash } from '../src/worker/catalog/hash.ts';
import {
  accountWithdrawals,
  instanceGrants,
  matchResults,
  organizationAccounts,
  questionSubmissions,
  resultPlayers,
} from '../src/worker/db/schema.ts';
import type { Env } from '../src/worker/env.ts';
import { organizationIdentity } from '../src/worker/organization/database.ts';
import { rankingExclusions } from '../src/worker/organization/moderation.ts';
import { recordWithdrawal } from '../src/worker/organization/withdrawal.ts';
import { commitResult } from '../src/worker/results/database.ts';

export async function verifyWithdrawal(
  db: PostgresJsDatabase,
  organizationId: string,
  instanceId: string,
  actors: string[],
) {
  const run = (subject: string, id: string) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return recordWithdrawal(tx, subject, id, 'default');
    });
  await assert.rejects(run('outsider', crypto.randomUUID()), /LAST_ADMINISTRATOR/);
  const id = crypto.randomUUID();
  const originals = await db.select().from(matchResults);
  const originalPlayers = await db.select().from(resultPlayers);
  const before = await db
    .select({ id: questionSubmissions.id })
    .from(questionSubmissions)
    .where(eq(questionSubmissions.authorId, actors[1]));
  await run('author', id);
  await run('author', id);
  await assert.rejects(run('reviewer', id), /OPERATION_CONFLICT/);
  await assert.rejects(organizationIdentity(db, 'author'), /ACCOUNT_WITHDRAWN/);
  await assert.rejects(run('author', crypto.randomUUID()), /ACCOUNT_WITHDRAWN/);
  assert.equal(
    (await db.select().from(instanceGrants).where(eq(instanceGrants.actorId, actors[1])))
      .length,
    0,
  );
  const after = await db
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.authorId, actors[1]));
  assert.deepEqual(after.map((row) => row.id).sort(), before.map((row) => row.id).sort());
  assert.ok(after.every((row) => row.authorName === '退会ユーザー'));
  assert.ok(
    (await rankingExclusions(db, organizationId, instanceId)).includes(actors[1]),
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      await tx
        .update(organizationAccounts)
        .set({ displayName: '復活' })
        .where(eq(organizationAccounts.actorId, actors[1]));
    }),
    (error: Error & { cause?: Error }) =>
      error.cause?.message === 'withdrawn account cannot be restored',
  );
  let calls = 0;
  const erase = (fail: boolean) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_erasure`);
      return eraseAuthentication(tx, id, async (subject) => {
        assert.equal(subject, 'author');
        calls++;
        if (fail) throw new Error('temporary outage');
      });
    });
  assert.equal(await erase(true), false);
  assert.equal(
    (await db.select().from(accountWithdrawals).where(eq(accountWithdrawals.id, id)))[0]
      .attempts,
    1,
  );
  assert.equal(await erase(false), true);
  assert.equal(await erase(false), true);
  assert.equal(calls, 2);
  const replacement = await organizationIdentity(db, 'new-auth-subject');
  assert.notEqual(replacement.account.actorId, actors[1]);
  assert.equal(replacement.account.administrator, false);
  assert.equal(replacement.account.displayName, null);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quiz_erasure`);
    await eraseResultNames(tx);
    await anonymizeWithdrawal(
      tx,
      {
        GAME_ROOM: {
          idFromString: (id: string) => id,
          get: () => ({ anonymizeAccount: async () => {} }),
        },
        MATCHMAKER: {
          getByName: () => ({
            anonymizeAccount: async () => {},
            beginWithdrawal: async () => ({ ok: true }),
            logoutActor: async () => ({ ok: true }),
          }),
        },
      } as unknown as Pick<Env, 'GAME_ROOM' | 'MATCHMAKER'>,
      id,
    );
  });
  assert.equal(
    (await db.select().from(accountWithdrawals).where(eq(accountWithdrawals.id, id)))[0]
      .erasedAt,
    null,
  );
  for (const original of originals) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_game_results`);
      await commitResult(tx, original.payload);
    });
  }
  const stored = await db.select().from(matchResults);
  for (const row of stored) {
    assert.equal(row.payloadHash, await contentHash(row.payload));
    assert.ok(
      row.payload.players
        .filter((p) => p.id === actors[1])
        .every((p) => p.name === '退会ユーザー'),
    );
  }
  const players = await db.select().from(resultPlayers);
  assert.deepEqual(
    players
      .map(({ name: _, ...player }) => player)
      .sort((a, b) => (a.resultId + a.actorId).localeCompare(b.resultId + b.actorId)),
    originalPlayers
      .map(({ name: _, ...player }) => player)
      .sort((a, b) => (a.resultId + a.actorId).localeCompare(b.resultId + b.actorId)),
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_erasure`);
      const changed = {
        ...stored[0].payload,
        players: stored[0].payload.players.map((p) => ({ ...p, ratingDelta: 999 })),
      };
      await tx.execute(
        sql`select quiz_game.erase_result_names(${stored[0].resultId}::uuid,${JSON.stringify(changed)}::jsonb,${await contentHash(changed)})`,
      );
    }),
  );
  console.log(
    'PASS: withdrawal authorization, last administrator guard, immutable retirement, post/question ownership retention, ranking exclusion, idempotent isolated Auth deletion and retry',
  );
}
