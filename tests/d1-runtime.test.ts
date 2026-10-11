import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it, vi } from 'vitest';
import type { OrganizationOverview } from '../src/shared/organization';
import type { ResultsOverview } from '../src/shared/results';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import { instances, matchResults, resultOutbox } from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { readStored, writeStored } from '../src/worker/game/storage';
import app from '../src/worker/index';
import { organizationIdentity } from '../src/worker/organization/database';
import { makeResultRecord } from '../src/worker/results/record';
import { resultFixture } from './fixtures/result';

// Only the external identity provider is replaced. Routes, DO and D1 stay real.
vi.mock('../src/worker/auth/clerk', () => ({
  authenticateClerk: async (request: Request) => ({
    subject: request.headers.get('Authorization')?.slice(7),
    displayName: '検証用',
  }),
}));
const runtime = env as unknown as Env & {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const environment: Env = {
  ...runtime,
  AUTH_PROVIDER: 'clerk',
  CLERK_PUBLISHABLE_KEY: 'pk_test_fixture',
  CLERK_SECRET_KEY: 'sk_test_fixture',
  INITIAL_ADMIN_SUBJECT: 'runtime-admin',
  ORGANIZATION_ENABLED: 'true',
  GAME_CONFIG_PROFILE: 'local',
};
const db = connectD1(runtime.GAME_D1);
const request = (path: string, body: object, subject = 'runtime-admin') =>
  app.request(
    `https://game.test${path}`,
    {
      method: 'POST',
      headers: {
        Origin: 'https://game.test',
        Authorization: `Bearer ${subject}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    environment,
  );
beforeAll(() => applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS));

it('通常APIで作った組織に、対戦DOがD1へ保存した結果と本人順位を返す', async () => {
  expect(
    (
      await request('/api/organization/setup', {
        name: '隔離した実経路検証',
        instanceName: '対戦保存対象',
      })
    ).status,
  ).toBe(200);
  const overview = await (
    await request('/api/organization/overview', {})
  ).json<OrganizationOverview>();
  const [instance] = await db
    .select()
    .from(instances)
    .where(eq(instances.id, overview.instances[0].id));
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ state: 'published' })
        .where(eq(instances.id, instance.id)),
    );
  });
  const { organization, account } = await organizationIdentity(db, 'runtime-admin');
  const other = await organizationIdentity(db, 'runtime-other');
  const { state } = resultFixture();
  const now = Date.now();
  state.startedAt = now - 1000;
  if (!state.definition || !state.result) throw new Error('FIXTURE_REQUIRED');
  state.definition.competition.owner = instance.owner;
  state.definition.ruleset.owner = instance.owner;
  state.definition.questionSet.owner = instance.owner;
  state.players[0].id = account.actorId;
  state.players[1].id = other.account.actorId;
  state.result = { ...state.result, winnerId: account.actorId, finishedAt: now };
  state.completed = makeResultRecord(state, state.result);
  if (!state.completed) throw new Error('RESULT_REQUIRED');
  const room = runtime.GAME_ROOM.getByName(crypto.randomUUID());
  await runInDurableObject(room, async (object, context) => {
    await context.storage.transaction((transaction) =>
      writeStored(transaction, 'room', {
        registered: true,
        scope: {
          id: instance.id,
          organizationId: organization.id,
          owner: instance.owner,
          mode: 'ranked',
        },
        state,
        sessions: {},
        resultRetryAt: 1,
      }),
    );
    await object.alarm();
    expect(
      (await readStored<{ state: typeof state }>(context.storage, 'room'))?.state.result
        ?.storage,
    ).toBe('confirmed');
    await object.alarm();
  });
  const resultId = state.result.id;
  expect(
    await db.select().from(matchResults).where(eq(matchResults.resultId, resultId)),
  ).toHaveLength(1);
  expect(
    await db.select().from(resultOutbox).where(eq(resultOutbox.resultId, resultId)),
  ).toHaveLength(1);
  const path = `/api/results/overview?instance=${instance.id}`;
  const history = await (
    await request(path, { section: 'history' })
  ).json<ResultsOverview>();
  expect(history.history).toHaveLength(1);
  expect(history.history[0]).toMatchObject({ resultId, ratingDelta: 20, outcome: 'win' });
  expect(JSON.stringify(history)).not.toContain(state.questions[0].text);
  const ranking = await (
    await request(path, { section: 'self' })
  ).json<ResultsOverview>();
  expect(ranking.self).toEqual({ rank: 1, rating: 1020 });
  const stranger = await (
    await request(path, { section: 'history', resultId }, 'runtime-stranger')
  ).json<ResultsOverview>();
  expect(stranger.history).toEqual([]);
});
