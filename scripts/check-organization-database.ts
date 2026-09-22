import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { validateMatchConfig } from '../src/worker/catalog/config.ts';
import { contentHash } from '../src/worker/catalog/hash.ts';
import * as schema from '../src/worker/db/schema.ts';
import type { Env } from '../src/worker/env';
import { actorForSubject } from '../src/worker/organization/access.ts';
import {
  accountPermissions,
  addInstance,
  organizationIdentity,
  overview,
  publishInstance,
  renameInstance,
  resolveInstance,
  setInstanceGrants,
  setupOrganization,
} from '../src/worker/organization/database.ts';
import { commitResult } from '../src/worker/results/database.ts';
import { readResults } from '../src/worker/results/read.ts';
import type { ResultRecord } from '../src/worker/results/record';

async function main() {
  // No .env auto-loading. This script cannot target the existing project database.
  const address = process.env.LOCAL_ORGANIZATION_TEST_DATABASE_URL;
  if (!address) throw new Error('LOCAL_TEST_DATABASE_REQUIRED');
  const url = new URL(address);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/quiz_relay_organization_test'
  )
    throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
  const client = postgres(address, {
    ssl: false,
    max: 1,
    prepare: false,
    connect_timeout: 5,
  });
  const db = drizzle(client);
  const rollback = new Error('ROLLBACK_REHEARSAL');
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  try {
    const existing = await db.execute(
      sql`select 1 from pg_namespace where nspname = 'quiz_game' union all select 1 from pg_roles where rolname = 'quiz_game_reader'`,
    );
    assert.equal(existing.length, 0, 'Use an empty disposable PostgreSQL cluster');
    await assert.rejects(
      db.transaction(async (tx) => {
        for (const role of ['anon', 'authenticated']) {
          const found = await tx.execute(
            sql`select 1 from pg_roles where rolname = ${role}`,
          );
          if (!found.length)
            await tx.execute(
              role === 'anon' ? sql`create role anon` : sql`create role authenticated`,
            );
        }
        async function apply(min: number, max: number) {
          for (const entry of journal.entries.filter(
            (entry) => entry.idx >= min && entry.idx <= max,
          )) {
            const source = await readFile(`drizzle/${entry.tag}.sql`, 'utf8');
            for (const statement of source.split('--> statement-breakpoint'))
              if (statement.trim()) await tx.execute(sql.raw(statement));
          }
        }
        await apply(0, 10);
        const config = validateMatchConfig(
          JSON.parse(await readFile('config/matchmaking.json', 'utf8')),
        );
        const owner = config.owner;
        const questions = JSON.parse(
          await readFile('supabase/seeds/mock-hiragana.json', 'utf8'),
        );
        const rulesHash = await contentHash(config.rules);
        const manifestHash = await contentHash(questions);
        await tx.insert(schema.rulesetVersions).values({
          owner,
          rulesetId: config.rulesetId,
          version: 1,
          rulesHash,
          config: config.rules,
        });
        await tx.insert(schema.questionVersions).values(
          questions.map((q: { id: string }) => ({
            owner,
            questionId: q.id,
            version: 1,
            payload: q,
          })),
        );
        await tx
          .insert(schema.questionAvailability)
          .values(questions.map((q: { id: string }) => ({ owner, questionId: q.id })));
        await tx
          .insert(schema.questionSets)
          .values({ owner, setId: config.questionSet.id, version: 1, manifestHash });
        await tx.insert(schema.questionSetItems).values(
          questions.map((q: { id: string }, ordinal: number) => ({
            owner,
            setId: config.questionSet.id,
            setVersion: 1,
            questionId: q.id,
            questionVersion: 1,
            ordinal: ordinal + 1,
          })),
        );
        await tx.insert(schema.competitions).values({
          owner,
          competitionId: config.competitionId,
          version: 1,
          playersPerMatch: config.playersPerMatch,
          rulesetId: config.rulesetId,
          rulesetVersion: 1,
          setId: config.questionSet.id,
          setVersion: 1,
        });
        await tx.insert(schema.matchmakingSettings).values({
          owner,
          profile: 'default',
          competitionId: config.competitionId,
          competitionVersion: 1,
        });
        const actorId = await actorForSubject(owner, 'player');
        const record: ResultRecord = {
          version: 1,
          owner,
          matchId: crypto.randomUUID(),
          kind: 'ranked',
          startedAt: 1000,
          ratingVersion: 1,
          result: {
            id: crypto.randomUUID(),
            reason: 'target_reached',
            winnerId: actorId,
            finishedAt: 2000,
          },
          definition: {
            competition: { owner, id: config.competitionId, version: 1 },
            ruleset: { owner, id: config.rulesetId, version: 1 },
            questionSet: { owner, id: config.questionSet.id, version: 1 },
            rules: config.rules,
            rulesHash,
            manifestHash,
            playersPerMatch: config.playersPerMatch,
          },
          players: [actorId, 'not-logged-in'].map((id) => ({
            id,
            name: id,
            correct: id === actorId ? 7 : 0,
            mistakes: 0,
            locked: false,
            disqualified: false,
            connected: true,
            ratingDelta: id === actorId ? 20 : -20,
          })),
        };
        await commitResult(tx, record);
        async function snapshot() {
          const tables = [
            schema.questionVersions,
            schema.questionAvailability,
            schema.questionSets,
            schema.questionSetItems,
            schema.rulesetVersions,
            schema.competitions,
            schema.matchmakingSettings,
            schema.matchResults,
            schema.resultPlayers,
            schema.resultOutbox,
          ];
          return Promise.all(
            tables.map(async (table) =>
              contentHash(
                (await tx.select().from(table)).map((row) => JSON.stringify(row)).sort(),
              ),
            ),
          );
        }
        const before = await snapshot();
        const history = await readResults(tx, owner, actorId);
        await apply(11, 16);
        await tx.execute(sql`set local role quiz_organization`);
        const runtime = { GAME_OWNER: owner, INITIAL_ADMIN_SUBJECT: 'installer' } as Env;
        await assert.rejects(
          setupOrganization(tx, runtime, 'intruder', {
            name: 'Org',
            instanceName: 'Original',
          }),
        );
        await setupOrganization(tx, runtime, 'installer', {
          name: 'Org',
          instanceName: 'Original',
        });
        await assert.rejects(
          setupOrganization(tx, runtime, 'installer', {
            name: 'Again',
            instanceName: 'Again',
          }),
        );
        const identity = await organizationIdentity(tx, 'player');
        assert.equal(identity.account.actorId, actorId);
        const id = crypto.randomUUID();
        await addInstance(tx, 'installer', { id, name: 'Second' });
        await addInstance(tx, 'installer', { id, name: 'Second' });
        await renameInstance(tx, 'installer', {
          id,
          name: 'Renamed',
          expectedName: 'Second',
        });
        await addInstance(tx, 'installer', { id, name: 'Second' });
        await assert.rejects(
          renameInstance(tx, 'installer', { id, name: 'Stale', expectedName: 'Second' }),
        );
        assert.equal((await overview(tx, 'player')).instances.length, 0);
        await assert.rejects(publishInstance(tx, 'player', { id }));
        await setInstanceGrants(tx, 'installer', {
          id,
          actorId,
          permissions: ['questions'],
          expected: '',
        });
        await assert.rejects(
          setInstanceGrants(tx, 'installer', {
            id,
            actorId,
            permissions: ['users'],
            expected: '',
          }),
        );
        assert.deepEqual(
          (await accountPermissions(tx, 'installer', { id, actorId })).grants?.map(
            (g) => g.permission,
          ),
          ['questions'],
        );
        const audit = await tx.select().from(schema.organizationEvents);
        assert.equal(audit.filter((event) => event.action === 'add').length, 1);
        assert.equal(audit.filter((event) => event.action === 'grants').length, 1);
        await assert.rejects(
          tx.transaction(async (savepoint) => {
            await savepoint.delete(schema.organizationEvents);
          }),
        );
        assert.equal(
          (await resolveInstance(tx, 'player', id)).permissions[0],
          'questions',
        );
        const first = (await overview(tx, 'installer')).instances.find(
          (instance) => instance.id !== id,
        );
        assert.ok(first);
        await assert.rejects(resolveInstance(tx, 'player', first.id));
        await publishInstance(tx, 'installer', { id });
        assert.equal((await overview(tx, 'player')).instances.length, 1);
        await assert.rejects(
          tx.transaction(async (savepoint) => {
            await savepoint
              .update(schema.instances)
              .set({ owner: 'https://wrong.test' })
              .where(eq(schema.instances.id, id));
          }),
        );
        await assert.rejects(
          tx.transaction(async (savepoint) => {
            await savepoint.select().from(schema.matchResults);
          }),
        );
        await tx.execute(sql`reset role`);
        await commitResult(tx, record);
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await readResults(tx, owner, actorId), history);
        assert.equal(
          (await readResults(tx, `urn:uuid:${id}`, actorId)).history.length,
          0,
        );
        await assert.rejects(
          tx.transaction(async (savepoint) => {
            await savepoint
              .update(schema.organizations)
              .set({ identityNamespace: 'changed' });
          }),
        );
        console.log(
          'PASS: identity, authorization, idempotency, originals/outbox/catalog hashes and ratings',
        );
        throw rollback;
      }),
      (error) => error === rollback,
    );
    assert.equal(
      (await db.execute(sql`select 1 from pg_namespace where nspname = 'quiz_game'`))
        .length,
      0,
    );
    console.log(
      'PASS: isolated migration transaction rolled back; backup restoration remains separate',
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error &&
      ['LOCAL_TEST_DATABASE_REQUIRED', 'DISPOSABLE_LOCAL_DATABASE_REQUIRED'].includes(
        error.message,
      )
      ? error.message
      : 'ORGANIZATION_REHEARSAL_FAILED',
  );
  process.exitCode = 1;
});
