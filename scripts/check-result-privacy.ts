import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eraseResultNames } from '../src/erasure/results.ts';
import { matchResults, organizationAccounts } from '../src/worker/db/schema.ts';
import { organizationIdentity } from '../src/worker/organization/database.ts';
import { recordWithdrawal } from '../src/worker/organization/withdrawal.ts';
import { commitResult, ResultConflict } from '../src/worker/results/database.ts';

export async function verifyResultPrivacyRaces(db: PostgresJsDatabase) {
  const [template] = await db.select().from(matchResults).limit(1);
  for (const stage of ['after-source', 'after-comparison'] as const) {
    const subject = crypto.randomUUID();
    const { account } = await organizationIdentity(db, subject);
    await db
      .update(organizationAccounts)
      .set({ displayName: '競合検証の旧名' })
      .where(eq(organizationAccounts.actorId, account.actorId));
    const record = structuredClone(template.payload);
    record.matchId = crypto.randomUUID();
    record.result = {
      ...record.result,
      id: crypto.randomUUID(),
      winnerId: null,
      finishedAt: Date.now(),
    };
    record.startedAt = Date.now() - 2000;
    record.players = [
      {
        id: account.actorId,
        name: '競合検証の旧名',
        correct: 1,
        mistakes: 0,
        locked: false,
        disqualified: false,
        connected: true,
        ratingDelta: 20,
      },
    ];
    await commitResult(db, record);
    const retire = () => recordWithdrawal(db, subject, crypto.randomUUID(), 'default');
    if (stage === 'after-comparison') await retire();
    let interleaved = false;
    const writer = {
      transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE quiz_game_results`);
          return callback({
            insert: tx.insert.bind(tx),
            execute: async (query: Parameters<typeof tx.execute>[0]) => {
              const rows = await tx.execute(query);
              if (stage === 'after-source' && !interleaved) {
                interleaved = true;
                await retire();
              }
              return rows;
            },
            select: (fields: Parameters<typeof tx.select>[0]) => ({
              from: (table: typeof matchResults) => ({
                leftJoin: (other: typeof matchResults, on: ReturnType<typeof eq>) => ({
                  where: async (condition: ReturnType<typeof eq>) => {
                    const rows = await tx
                      .select(fields)
                      .from(table)
                      .leftJoin(other, on)
                      .where(condition);
                    if (stage === 'after-comparison' && !interleaved) {
                      interleaved = true;
                      await db.transaction(async (privacy) => {
                        await privacy.execute(sql`SET LOCAL ROLE quiz_erasure`);
                        await eraseResultNames(privacy);
                      });
                    }
                    return rows;
                  },
                }),
              }),
            }),
          });
        }),
    } as unknown as Parameters<typeof commitResult>[0];
    await commitResult(writer, record);
    assert.ok(interleaved);
    await commitResult(db, record);
    const changed = structuredClone(record);
    changed.players[0].ratingDelta++;
    await assert.rejects(commitResult(db, changed), ResultConflict);
  }
  console.log(
    'PASS: result replay across concurrent withdrawal/anonymization and genuine conflict rejection',
  );
}
