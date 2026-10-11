import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ParticipationTarget } from '../src/shared/participation';
import { validateDefinition } from '../src/worker/catalog/definition';
import { contentHash } from '../src/worker/catalog/hash';
import type { Env } from '../src/worker/env';
import { rules } from '../src/worker/game/rules';
import { readStored } from '../src/worker/game/storage';
import { questions } from './fixtures/questions';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  release: vi.fn(),
  status: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../src/worker/catalog/database', () => ({ loadMatchDefinition: mocks.load }));
vi.mock('../src/worker/organization/database', () => ({
  allowedInstanceActors: async (_env: Env, _scope: unknown, actors: string[]) => actors,
}));
vi.mock('../src/worker/organization/rooms', () => ({ registerInstanceRoom: vi.fn() }));
vi.mock('../src/worker/federation/slots', () => ({
  releaseForeignEntry: mocks.release,
  foreignEntryStatus: mocks.status,
  logoutForeignEntry: mocks.logout,
}));
const runtime = env as unknown as Env;
let organization: string, scope: { id: string; owner: string }, actor: string;
const target = (): ParticipationTarget => ({
  peerOrigin: 'https://host.quiz-relay.workers.dev',
  sourceInstanceId: scope.id,
  hostInstanceId: crypto.randomUUID(),
  mode: 'ranked',
});
const maker = () => runtime.MATCHMAKER.getByName(organization);
beforeEach(async () => {
  vi.clearAllMocks();
  organization = crypto.randomUUID();
  actor = crypto.randomUUID();
  scope = { id: crypto.randomUUID(), owner: `urn:uuid:${crypto.randomUUID()}` };
  mocks.release.mockResolvedValue(undefined);
  mocks.logout.mockResolvedValue(undefined);
  mocks.status.mockResolvedValue({ active: true, phase: 'WAITING' });
  const config = { ...rules, showSelections: true };
  mocks.load.mockResolvedValue(
    await validateDefinition({
      competition: { owner: scope.owner, id: 'demo', version: 1 },
      ruleset: { owner: scope.owner, id: 'demo', version: 1 },
      questionSet: { owner: scope.owner, id: 'demo', version: 1 },
      rules: config,
      questions,
      playersPerMatch: 2,
      rulesHash: await contentHash(config),
      manifestHash: await contentHash(questions),
    }),
  );
});
async function queue() {
  return runInDurableObject(maker(), async (_instance, state) =>
    state.storage.get<{
      actors: Record<string, { room: string }>;
      foreign?: Record<string, { operationId: string; state: string }[]>;
      foreignDepartures?: Record<string, unknown>;
    }>('queue'),
  );
}
it('ローカル待機と外部予約を同じ2枠へ数え、成立後に旧本人だけを離脱させる', async () => {
  const local = await maker().enter(actor, '本人', undefined, false, scope);
  if (!local.ok) throw new Error(local.code);
  const operationId = crypto.randomUUID(),
    destination = target();
  expect(
    await maker().claimForeign(actor, destination, operationId, '本人'),
  ).toMatchObject({
    ok: true,
    name: '本人',
  });
  expect(
    await maker().claimForeign(actor, destination, operationId, '更新後の名前'),
  ).toMatchObject({ ok: true, name: '本人' });
  expect(
    await maker().claimForeign(actor, target(), crypto.randomUUID(), '本人'),
  ).toMatchObject({ ok: false, code: 'MATCH_SWITCH_PENDING' });
  expect(
    await maker().enter(
      actor,
      '本人',
      undefined,
      false,
      scope,
      false,
      crypto.randomUUID(),
    ),
  ).toMatchObject({ ok: false, code: 'MATCH_SWITCH_PENDING' });
  expect((await queue())?.actors[actor].room).toBe(local.room);
  expect(
    await maker().commitForeign(
      actor,
      operationId,
      crypto.randomUUID(),
      Date.now() + 43200000,
    ),
  ).toEqual({ ok: true });
  expect((await queue())?.actors[actor]).toBeUndefined();
  const old = await runInDurableObject(
    runtime.GAME_ROOM.getByName(`1c:${local.room}`),
    async (_instance, state) =>
      readStored<{ state: { players: unknown[] } }>(state.storage, 'room'),
  );
  expect(old?.state.players).toEqual([]);
  expect((await queue())?.foreign?.[actor]).toHaveLength(1);
});
it('ログアウト未確認は再認証を止め、Alarmで確認後に古い認証世代を無効にする', async () => {
  const operationId = crypto.randomUUID(),
    destination = target(),
    claimed = await maker().claimForeign(actor, destination, operationId, '本人');
  if (!claimed.ok) throw new Error(claimed.code);
  await maker().commitForeign(
    actor,
    operationId,
    crypto.randomUUID(),
    Date.now() + 43200000,
    claimed.authorizationId,
  );
  expect(
    await maker().foreignAuthorization(
      actor,
      operationId,
      claimed.authorizationId,
      destination,
    ),
  ).toBe(true);
  mocks.logout.mockRejectedValue(new Error('offline'));
  await maker().logoutActor(actor);
  expect(
    await maker().foreignAuthorization(
      actor,
      operationId,
      claimed.authorizationId,
      destination,
    ),
  ).toBe(false);
  expect(
    await maker().claimForeign(actor, destination, operationId, '本人'),
  ).toMatchObject({ ok: false, code: 'LOGOUT_PENDING' });
  expect(mocks.release).not.toHaveBeenCalled();
  mocks.logout.mockResolvedValue(undefined);
  await runDurableObjectAlarm(maker());
  const resumed = await maker().claimForeign(actor, destination, operationId, '本人');
  if (!resumed.ok) throw new Error(resumed.code);
  expect(resumed.authorizationId).not.toBe(claimed.authorizationId);
  expect(
    await maker().foreignAuthorization(
      actor,
      operationId,
      claimed.authorizationId,
      destination,
    ),
  ).toBe(false);
  expect(
    await maker().foreignAuthorization(
      actor,
      operationId,
      resumed.authorizationId,
      destination,
    ),
  ).toBe(true);
  expect(
    await maker().commitForeign(
      actor,
      operationId,
      crypto.randomUUID(),
      Date.now() + 43200000,
      claimed.authorizationId,
    ),
  ).toMatchObject({ ok: false, code: 'STALE_REQUEST' });
});
it('離脱応答が不明な旧外部枠を保持し、3枠目を拒否してAlarmから復旧する', async () => {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  await maker().claimForeign(actor, target(), first, '本人');
  await maker().commitForeign(actor, first, crypto.randomUUID(), Date.now() + 43200000);
  await maker().claimForeign(actor, target(), second, '本人');
  mocks.release.mockRejectedValue(new Error('offline'));
  await maker().commitForeign(actor, second, crypto.randomUUID(), Date.now() + 43200000);
  expect((await queue())?.foreign?.[actor]).toHaveLength(2);
  expect(
    await maker().enter(
      actor,
      '本人',
      undefined,
      false,
      scope,
      false,
      crypto.randomUUID(),
    ),
  ).toMatchObject({ ok: false, code: 'MATCH_SWITCH_PENDING' });
  expect(
    await maker().claimForeign(actor, target(), crypto.randomUUID(), '本人'),
  ).toMatchObject({ ok: false, code: 'MATCH_SWITCH_PENDING' });
  expect(
    await maker().enterRoom(
      { id: actor, name: '本人', guest: false },
      crypto.randomUUID(),
      { ...scope, mode: 'room' },
      { operationId: crypto.randomUUID(), password: '', invite: '' },
    ),
  ).toMatchObject({ ok: false, code: 'MATCH_SWITCH_PENDING' });
  mocks.release.mockResolvedValue(undefined);
  await runDurableObjectAlarm(maker());
  expect((await queue())?.foreign?.[actor]).toEqual([
    expect.objectContaining({ operationId: second, state: 'active' }),
  ]);
});
it('新しいローカル参加が拒否された場合は、元の外部参加を維持する', async () => {
  const operationId = crypto.randomUUID();
  await maker().claimForeign(actor, target(), operationId, '本人');
  await maker().commitForeign(
    actor,
    operationId,
    crypto.randomUUID(),
    Date.now() + 43200000,
  );
  mocks.load.mockRejectedValueOnce(new Error('DB_UNAVAILABLE'));
  expect(
    await maker().enter(
      actor,
      '本人',
      undefined,
      false,
      scope,
      false,
      crypto.randomUUID(),
    ),
  ).toMatchObject({ ok: false, code: 'GAME_DATABASE_UNAVAILABLE' });
  expect(mocks.release).not.toHaveBeenCalled();
  expect((await queue())?.foreign?.[actor]).toEqual([
    expect.objectContaining({ operationId, state: 'active' }),
  ]);
  const local = await maker().enter(
    actor,
    '本人',
    undefined,
    false,
    scope,
    false,
    crypto.randomUUID(),
  );
  expect(local.ok).toBe(true);
  expect((await queue())?.foreign?.[actor]).toBeUndefined();
  expect(mocks.release).toHaveBeenCalledTimes(1);
});
it('期限切れの応答不明予約も離脱確認まで枠を解放せず、遅延確定を拒否する', async () => {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  await maker().claimForeign(actor, target(), first, '本人');
  await maker().claimForeign(actor, target(), second, '本人');
  await runInDurableObject(maker(), async (_instance, state) => {
    const queue = await state.storage.get<{
      foreign: Record<string, { expiresAt: number }[]>;
    }>('queue');
    if (!queue) throw new Error('QUEUE_REQUIRED');
    for (const entry of queue.foreign[actor]) entry.expiresAt = Date.now() - 1;
    await state.storage.put('queue', queue);
  });
  mocks.release.mockRejectedValue(new Error('offline'));
  await runDurableObjectAlarm(maker());
  expect((await queue())?.foreign?.[actor]).toHaveLength(2);
  expect(
    await maker().commitForeign(actor, first, crypto.randomUUID(), Date.now() + 43200000),
  ).toMatchObject({ ok: false, code: 'STALE_REQUEST' });
  expect(
    await maker().claimForeign(actor, target(), crypto.randomUUID(), '本人'),
  ).toMatchObject({ ok: false, code: 'MATCH_SWITCH_PENDING' });
  mocks.release.mockResolvedValue(undefined);
  await runDurableObjectAlarm(maker());
  expect((await queue())?.foreign?.[actor]).toBeUndefined();
});
