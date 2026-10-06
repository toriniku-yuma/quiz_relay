import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { defaultQuestionSettings } from '../src/shared/questions.ts';
import { loadMatchDefinition } from '../src/worker/catalog/database.ts';
import {
  organizationAccounts,
  questionSets,
  questionSettings,
  questionSubmissions,
} from '../src/worker/db/schema.ts';
import type { Env } from '../src/worker/env.ts';
import { currentProfileNames, saveProfile } from '../src/worker/organization/profile.ts';

// Invoked by the isolated question-database verifier; never opens a configured production DB.
export async function verifyProfiles(
  db: PostgresJsDatabase,
  input: {
    address: string;
    organizationId: string;
    instanceId: string;
    owner: string;
    actorId: string;
  },
) {
  const save = (subject: string, displayName: string, revision = 0) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return saveProfile(tx, subject, { displayName, revision }, 'local');
    });
  const [settings] = await db
    .select()
    .from(questionSettings)
    .where(eq(questionSettings.instanceId, input.instanceId));
  await db
    .insert(questionSettings)
    .values({
      instanceId: input.instanceId,
      config: { ...(settings?.config ?? defaultQuestionSettings), showAuthor: true },
    })
    .onConflictDoUpdate({
      target: questionSettings.instanceId,
      set: {
        config: { ...(settings?.config ?? defaultQuestionSettings), showAuthor: true },
      },
    });
  const oldSets = await db
    .select()
    .from(questionSets)
    .where(eq(questionSets.owner, input.owner));
  const previousAccount = (
    await db
      .select()
      .from(organizationAccounts)
      .where(eq(organizationAccounts.actorId, input.actorId))
  )[0];
  const originalInputs = await db
    .select({
      id: questionSubmissions.id,
      input: questionSubmissions.input,
      revision: questionSubmissions.revision,
      status: questionSubmissions.status,
    })
    .from(questionSubmissions)
    .where(eq(questionSubmissions.authorId, input.actorId));
  assert.deepEqual(await save('admin', '　ＡＤＭＩＮ改名　'), {
    displayName: 'ADMIN改名',
    revision: 1,
  });
  assert.deepEqual(await save('admin', 'ADMIN改名'), {
    displayName: 'ADMIN改名',
    revision: 1,
  });
  await assert.rejects(save('admin', '別の名前'), /EDIT_CONFLICT/);
  await assert.rejects(save('admin', '\n名前', 1), /INVALID_PROFILE/);
  await assert.rejects(save('author', 'ＡＤＭＩＮ改名'), /DISPLAY_NAME_TAKEN/);
  const account = (
    await db
      .select()
      .from(organizationAccounts)
      .where(eq(organizationAccounts.actorId, input.actorId))
  )[0];
  assert.equal(account.actorId, previousAccount.actorId);
  assert.equal(account.administrator, previousAccount.administrator);
  assert.equal(account.subject, previousAccount.subject);
  const rows = await db
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.authorId, input.actorId));
  assert.ok(rows.length > 0 && rows.every((row) => row.authorName === 'ADMIN改名'));
  assert.deepEqual(
    rows
      .map(({ id, input: question, revision, status }) => ({
        id,
        input: question,
        revision,
        status,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    originalInputs.sort((left, right) => left.id.localeCompare(right.id)),
  );
  for (const old of oldSets) {
    const [stored] = await db
      .select()
      .from(questionSets)
      .where(
        and(
          eq(questionSets.owner, old.owner),
          eq(questionSets.setId, old.setId),
          eq(questionSets.version, old.version),
        ),
      );
    assert.deepEqual(stored, old);
  }
  const definition = await loadMatchDefinition({
    GAME_OWNER: input.owner,
    GAME_CONFIG_PROFILE: 'local',
    GAME_DATABASE_URL: input.address,
  } as Env);
  const own = rows.find(
    (row) => row.publishedId && definition.selection?.authorNames?.[row.publishedId],
  );
  assert.ok(own?.publishedId);
  assert.equal(definition.selection?.authorNames?.[own.publishedId], 'ADMIN改名');
  const names = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
    return currentProfileNames(tx, input.organizationId, [input.actorId]);
  });
  assert.equal(names.get(input.actorId), 'ADMIN改名');
  const collision = await Promise.allSettled([
    save('reviewer', '同時登録'),
    save('outsider', '同時登録'),
  ]);
  assert.equal(collision.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(collision.filter((result) => result.status === 'rejected').length, 1);
  assert.match(
    String(collision.find((result) => result.status === 'rejected')?.reason),
    /DISPLAY_NAME_TAKEN/,
  );
  const edits = await Promise.allSettled([
    save('admin', '同時変更A', 1),
    save('admin', '同時変更B', 1),
  ]);
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(
    String(edits.find((result) => result.status === 'rejected')?.reason),
    /EDIT_CONFLICT/,
  );
  console.log(
    'プロフィールDB検証成功：正規化・実ロール保存・重複/競合拒否・同一再送・全投稿改名・旧カタログ保持・次試合反映',
  );
}
