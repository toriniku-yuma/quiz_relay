import {
  applyD1Migrations,
  env,
  evictDurableObject,
  runInDurableObject,
} from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { newRoomSettings, type RoomView } from '../src/shared/rooms';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import {
  federationActors,
  federationControlDeliveries,
  federationLoginSessions,
  federationParticipations,
  federationPeers,
  federationReservations,
  federationResultDeliveries,
  federationResultInbox,
  federationSessions,
  instances,
  moderationSanctions,
  organizationAccounts,
  organizations,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { planControlEvent } from '../src/worker/federation/controls';
import {
  externalInstanceDirectory,
  favoriteExternalInstance,
} from '../src/worker/federation/directory';
import { resolveExternalInstance } from '../src/worker/federation/discovery';
import { signEvent } from '../src/worker/federation/events';
import {
  authorizeForeignLogin,
  exchangeForeignLogin,
  foreignLoginSession,
  logoutForeignLogin,
} from '../src/worker/federation/login';
import { localMetadata } from '../src/worker/federation/metadata';
import {
  authorizeParticipation,
  exchangeParticipation,
  participationSession,
  refreshParticipationAccess,
  reserveParticipation,
  resumeParticipation,
} from '../src/worker/federation/participation';
import {
  deliverResult,
  dispatchSavedResult,
  foreignHistory,
  hostResultReview,
  receiveResultEvent,
  reviewForeignResult,
} from '../src/worker/federation/results';
import {
  authorizeSessionParticipation,
  joinForeignLogin,
} from '../src/worker/federation/session-participation';
import {
  expireFederationSessions,
  expireHostParticipations,
  logoutHostParticipation,
} from '../src/worker/federation/slots';
import {
  signParticipationTicket,
  verifyParticipationGrant,
  verifyParticipationTicket,
} from '../src/worker/federation/tickets';
import { signedDelivery } from '../src/worker/federation/transport';
import { advance, type State } from '../src/worker/game/state';
import { readStored, writeStored } from '../src/worker/game/storage';
import app from '../src/worker/index';
import {
  allowedInstanceActors,
  setupOrganization,
} from '../src/worker/organization/database';
import { readResults } from '../src/worker/results/read';
import { scheduledD1 } from '../src/worker/scheduled';
import { commitFixtureResult } from './fixtures/match';
import { resetMatchmaker } from './fixtures/matchmaker';
import { resultFixture } from './fixtures/result';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  PEER_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const sourceOrigin = 'https://source.quiz-relay.workers.dev',
  hostOrigin = 'https://host.quiz-relay.workers.dev',
  sourceDb = connectD1(runtime.PEER_D1),
  hostDb = connectD1(runtime.GAME_D1);
let source: Env,
  host: Env,
  sourceId: string,
  hostId: string,
  actorId: string,
  sourceOwner: string,
  hostOwner: string,
  operationId: string,
  phase: 'WAITING' | 'REVEALING' | 'FINISHED',
  matchId: string,
  roomId: string;
let authorizationId: string;
const enter = vi.fn(),
  identity = vi.fn(),
  cancelAdmission = vi.fn(),
  cancel = vi.fn();
const unlimited: RateLimit = { limit: async () => ({ success: true }) };
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await applyD1Migrations(runtime.PEER_D1, runtime.D1_MIGRATIONS);
  const sourceKeys = await generateKeyPair('EdDSA', { extractable: true }),
    hostKeys = await generateKeyPair('EdDSA', { extractable: true });
  source = {
    ...env,
    // Rate-limit behavior is covered separately; unrelated cases do not share one quota.
    API_LIMITER: unlimited,
    FEDERATION_LIMITER: unlimited,
    GAME_D1: runtime.PEER_D1,
    FEDERATION_ORIGIN: sourceOrigin,
    SIGNING_KID: 'source',
    SIGNING_PRIVATE_KEY: await exportPKCS8(sourceKeys.privateKey),
  } as unknown as Env;
  host = {
    ...env,
    API_LIMITER: unlimited,
    FEDERATION_LIMITER: unlimited,
    GAME_D1: runtime.GAME_D1,
    FEDERATION_ORIGIN: hostOrigin,
    SIGNING_KID: 'host',
    SIGNING_PRIVATE_KEY: await exportPKCS8(hostKeys.privateKey),
    // This test verifies actual D1, transport, tickets and cookie routes. The
    // room allocation RPC is controlled; live DO play is a separate acceptance.
    MATCHMAKER: { getByName: () => ({ enter, cancel, cancelAdmission }) },
    GAME_ROOM: { getByName: () => ({ reservationIdentity: identity }) },
  } as unknown as Env;
  await setupOrganization(
    sourceDb,
    { INITIAL_ADMIN_SUBJECT: 'source-admin' } as Env,
    'source-admin',
    { name: '所属元', instanceName: '所属元' },
  );
  await setupOrganization(
    hostDb,
    { INITIAL_ADMIN_SUBJECT: 'host-admin' } as Env,
    'host-admin',
    { name: '開催元', instanceName: '開催元' },
  );
  actorId = (await sourceDb.select().from(organizationAccounts))[0].actorId;
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .update(organizationAccounts)
        .set({ displayName: '参加者', profileRevision: 1 }),
      sourceDb.insert(federationPeers).values({
        origin: hostOrigin,
        name: '開催元',
        kid: 'host',
        publicKey: await exportSPKI(hostKeys.publicKey),
        approved: true,
      }),
    );
  });
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb.insert(federationPeers).values({
        origin: sourceOrigin,
        name: '所属元',
        kid: 'source',
        publicKey: await exportSPKI(sourceKeys.publicKey),
        approved: true,
      }),
    );
  });
});
beforeEach(async () => {
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb.update(federationPeers).set({
        approved: true,
        discovered: false,
        participationBlocked: false,
        receiveRanked: true,
        receiveCasual: true,
      }),
    );
  });
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb.update(organizations).set({ externalParticipation: 'approved' }),
      hostDb.update(federationPeers).set({
        approved: true,
        participationBlocked: false,
        receiveRanked: true,
        receiveCasual: true,
      }),
    );
  });
  phase = 'WAITING';
  matchId = crypto.randomUUID();
  roomId = crypto.randomUUID();
  operationId = crypto.randomUUID();
  authorizationId = crypto.randomUUID();
  cancel.mockReset().mockResolvedValue({ ok: true });
  cancelAdmission.mockReset().mockResolvedValue({ ok: true });
  sourceId = (await sourceDb.select().from(organizations))[0].id;
  hostId = crypto.randomUUID();
  const sourceInstanceId = crypto.randomUUID();
  sourceOwner = `urn:uuid:${sourceInstanceId}`;
  hostOwner = `urn:uuid:${hostId}`;
  const sourceTemplate = (await sourceDb.select().from(instances))[0],
    hostTemplate = (await hostDb.select().from(instances))[0];
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb.insert(instances).values({
        ...sourceTemplate,
        id: sourceInstanceId,
        owner: sourceOwner,
        state: 'published',
      }),
    );
  });
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .insert(instances)
        .values({ ...hostTemplate, id: hostId, owner: hostOwner, state: 'published' }),
    );
  });
  enter.mockReset().mockImplementation(async () => ({
    ok: true,
    room: roomId,
    token: 'server-only-session-token',
    expires: Date.now() + 43200000,
  }));
  identity.mockReset().mockImplementation(async () => ({ matchId, phase }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) =>
    app.request(
      request as Request,
      undefined,
      new URL((request as Request).url).origin === hostOrigin ? host : source,
    ),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});
const authorize = () =>
  authorizeParticipation(source, 'source-admin', {
    sourceOrganizationId: sourceId,
    hostInstanceId: hostId,
    peerOrigin: hostOrigin,
    mode: 'ranked',
    operationId,
  });
const request = () => ({
  sourceOrganizationId: sourceId,
  hostInstanceId: hostId,
  mode: 'ranked',
  operationId,
  actorId,
  displayName: '参加者',
  serverName: '所属元',
  authorizationId,
});
it('参加APIはレート制限のbindingが無ければ処理せず設定エラーを返す', async () => {
  const response = await app.request(
    `${hostOrigin}/api/v1/participation/session`,
    { headers: { Origin: hostOrigin } },
    { ...host, API_LIMITER: undefined },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: 'RATE_LIMITER_NOT_CONFIGURED' });
});
it('URLで初めて確認した未承認の開催先をお気に入りにし、開催元の許可で署名付き参加を確定する', async () => {
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb.delete(federationPeers).where(eq(federationPeers.origin, hostOrigin)),
    );
  });
  const url = `${hostOrigin}/game/?instance=${hostId}`;
  const resolved = await resolveExternalInstance(source, 'source-admin', {
    operation: 'resolve',
    url,
  });
  const [peer] = await sourceDb
    .select()
    .from(federationPeers)
    .where(eq(federationPeers.origin, hostOrigin));
  expect(peer).toMatchObject({
    approved: false,
    discovered: true,
    participationBlocked: false,
  });
  const withdrawal = {
    version: 1 as const,
    type: 'withdrawal' as const,
    eventId: crypto.randomUUID(),
    subjectId: actorId,
    createdAt: Date.now(),
  };
  await changeD1(sourceDb, (writes) => planControlEvent(sourceDb, writes, withdrawal));
  expect(
    await sourceDb
      .select()
      .from(federationControlDeliveries)
      .where(eq(federationControlDeliveries.eventId, withdrawal.eventId)),
  ).toHaveLength(0);
  expect(resolved.instance).toMatchObject({ available: true, ranked: true });
  expect(
    (await externalInstanceDirectory(sourceDb, 'source-admin')).instances,
  ).toHaveLength(0);
  await favoriteExternalInstance(sourceDb, 'source-admin', {
    operation: 'favorite',
    peerOrigin: hostOrigin,
    instanceId: hostId,
    added: true,
  });
  expect(
    (await externalInstanceDirectory(sourceDb, 'source-admin')).instances,
  ).toHaveLength(1);
  const ticket = await authorize();
  const visitedWithdrawal = { ...withdrawal, eventId: crypto.randomUUID() };
  await changeD1(sourceDb, (writes) =>
    planControlEvent(sourceDb, writes, visitedWithdrawal),
  );
  expect(
    await sourceDb
      .select()
      .from(federationControlDeliveries)
      .where(eq(federationControlDeliveries.eventId, visitedWithdrawal.eventId)),
  ).toHaveLength(1);
  expect(
    (await exchangeParticipation(host, { ticket: ticket.ticket })).row.sourceActorId,
  ).toBe(actorId);
  expect(
    await sourceDb
      .select()
      .from(federationParticipations)
      .where(eq(federationParticipations.matchId, matchId)),
  ).toHaveLength(1);
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .update(federationPeers)
        .set({ participationBlocked: true })
        .where(eq(federationPeers.origin, hostOrigin)),
    );
  });
  await expect(authorize()).rejects.toThrow('FEDERATION_PARTICIPATION_DENIED');
});
it('自分の参加記録に一致する結果だけを未承認の開催元から受信し、予約・試合・本人の取り違えを拒否する', async () => {
  const { job } = await savedForeignResult();
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .update(federationPeers)
        .set({ approved: false, discovered: true })
        .where(eq(federationPeers.origin, hostOrigin)),
    );
  });
  for (const change of [
    { matchId: crypto.randomUUID() },
    { reservationId: crypto.randomUUID() },
    { sourceActorId: 'e'.repeat(64) },
  ]) {
    const payload = { ...job.payload, eventId: crypto.randomUUID(), ...change };
    await expect(
      receiveResultEvent(source, hostOrigin, await signEvent(host, payload)),
    ).rejects.toThrow('FEDERATION_RESULT_DENIED');
  }
  await deliverResult(host, job.eventId);
  expect(await deliveredHistory(job.matchId)).toHaveLength(1);
});
it('新しい参加は組織単位で、所属元のインスタンス停止に依存せず、組織BANを確認する', async () => {
  const [organization] = await sourceDb.select().from(organizations);
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .update(instances)
        .set({ state: 'archived', rankedPauseReason: '停止' })
        .where(eq(instances.owner, sourceOwner)),
    );
  });
  const ticket = await authorize();
  const session = await exchangeParticipation(host, { ticket: ticket.ticket });
  expect(session.row.sourceOrganizationId).toBe(organization.id);
  expect((await resumeParticipation(host, session.secret)).reservation.id).toBe(
    session.row.id,
  );
  const sanctionId = crypto.randomUUID();
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb.insert(moderationSanctions).values({
        id: sanctionId,
        organizationId: organization.id,
        actorId,
        kind: 'ban',
        restrictions: [],
        reason: '検証',
        instanceId: null,
      }),
    );
  });
  await refreshParticipationAccess(host, hostId, [session.row.actorId], true);
  expect(
    await allowedInstanceActors(host, { id: hostId, owner: hostOwner }, [
      session.row.actorId,
    ]),
  ).toEqual([]);
  await expect(authorize()).rejects.toThrow('PARTICIPATION_RESTRICTED');
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .update(moderationSanctions)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(moderationSanctions.id, sanctionId)),
    );
  });
  await refreshParticipationAccess(host, hostId, [session.row.actorId], true);
  expect(
    await allowedInstanceActors(host, { id: hostId, owner: hostOwner }, [
      session.row.actorId,
    ]),
  ).toEqual([session.row.actorId]);
});
it('禁止以外を許可する開催元は未登録組織の鍵だけを取得し、参加・個人履歴を許可して問題共有を拒否する', async () => {
  const newOrigin = 'https://new-source.quiz-relay.workers.dev';
  const newcomer = { ...source, FEDERATION_ORIGIN: newOrigin };
  vi.mocked(fetch).mockImplementation(async (request) =>
    app.request(
      request as Request,
      undefined,
      new URL((request as Request).url).origin === hostOrigin ? host : newcomer,
    ),
  );
  const input = {
    sourceOrganizationId: sourceId,
    hostInstanceId: hostId,
    peerOrigin: hostOrigin,
    mode: 'ranked',
    operationId,
  };
  const authorizeNew = () => authorizeParticipation(newcomer, 'source-admin', input);
  await expect(authorizeNew()).rejects.toThrow('FEDERATION_PEER_UNAVAILABLE');
  expect(
    await hostDb
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.origin, newOrigin)),
  ).toHaveLength(0);
  await changeD1(hostDb, async (writes) => {
    writes.push(hostDb.update(organizations).set({ externalParticipation: 'unblocked' }));
  });
  const ticket = await authorizeNew();
  const session = await exchangeParticipation(host, { ticket: ticket.ticket });
  const [peer] = await hostDb
    .select()
    .from(federationPeers)
    .where(eq(federationPeers.origin, newOrigin));
  expect(peer).toMatchObject({
    approved: false,
    discovered: true,
    participationBlocked: false,
  });
  const page = await localMetadata(hostDb, newOrigin, {
    sourceInstanceId: sourceId,
    targetInstanceId: hostId,
  });
  expect(page.instances[0]).toMatchObject({ ranked: true, casual: true });
  const questionMessage = await signedDelivery(
    newcomer,
    hostOrigin,
    '/federation/v1/questions/sync',
    'questions.request',
    { sourceInstanceId: hostId, targetInstanceId: sourceId },
  );
  const denied = await app.request(
    `${hostOrigin}/federation/v1/questions/sync`,
    { method: 'POST', body: JSON.stringify({ message: questionMessage }) },
    host,
  );
  expect(denied.status).toBe(403);
  const { record } = resultFixture();
  record.owner = hostOwner;
  record.matchId = matchId;
  record.definition.competition.owner = hostOwner;
  record.definition.ruleset.owner = hostOwner;
  record.definition.questionSet.owner = hostOwner;
  record.players = record.players.map((player, index) => ({
    ...player,
    id: index === 0 ? session.row.actorId : 'c'.repeat(64),
  }));
  record.result.finishedAt = Date.now();
  record.startedAt = Date.now() - 1000;
  record.result.winnerId = session.row.actorId;
  await commitFixtureResult(runtime.GAME_D1, record);
  const [job] = await hostDb
    .select()
    .from(federationResultDeliveries)
    .where(eq(federationResultDeliveries.matchId, record.matchId));
  await deliverResult(host, job.eventId);
  expect((await foreignHistory(newcomer, 'source-admin')).history).toContainEqual(
    expect.objectContaining({ eventId: job.eventId }),
  );
  await expect(
    reviewForeignResult(newcomer, 'source-admin', hostOrigin, job.eventId),
  ).resolves.toMatchObject({ questions: [] });
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .update(federationPeers)
        .set({ receiveRanked: false })
        .where(eq(federationPeers.origin, newOrigin)),
    );
  });
  await refreshParticipationAccess(host, hostId, [session.row.actorId], true);
  expect(
    await allowedInstanceActors(host, { id: hostId, owner: hostOwner }, [
      session.row.actorId,
    ]),
  ).toEqual([]);
  await expect(authorizeNew()).rejects.toThrow('FEDERATION_PEER_UNAVAILABLE');
  const limited = await localMetadata(hostDb, newOrigin, {
    sourceInstanceId: sourceId,
    targetInstanceId: hostId,
  });
  expect(limited.instances[0]).toMatchObject({ ranked: false, casual: true });
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .update(federationPeers)
        .set({ receiveRanked: true, approved: true, participationBlocked: true })
        .where(eq(federationPeers.origin, newOrigin)),
    );
  });
  await expect(authorizeNew()).rejects.toThrow('FEDERATION_PEER_UNAVAILABLE');
});
it('外部ログインで実ルームを作成・再送・開始し、親部屋に結び付いた結果を所属元へ配送する', async () => {
  const realHost: Env = {
    ...host,
    MATCHMAKER: (env as unknown as Env).MATCHMAKER,
    GAME_ROOM: (env as unknown as Env).GAME_ROOM,
  };
  const originalFetch = globalThis.fetch;
  vi.mocked(globalThis.fetch).mockImplementation(async (request) =>
    app.request(
      request as Request,
      undefined,
      new URL((request as Request).url).origin === hostOrigin ? realHost : source,
    ),
  );
  const authorized = await authorizeParticipation(source, 'source-admin', {
    sourceOrganizationId: sourceId,
    hostInstanceId: hostId,
    peerOrigin: hostOrigin,
    mode: 'room',
    operationId,
  });
  const session = await exchangeParticipation(realHost, { ticket: authorized.ticket });
  expect(session.row.mode).toBe('room');
  const cookie = `qr_fed_${session.row.id}=${session.secret}`;
  const call = (action: string, body: object) =>
    app.request(
      `${hostOrigin}/api/v1/participation/rooms/${action}?reservation=${session.row.id}`,
      {
        method: 'POST',
        headers: {
          Origin: hostOrigin,
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      realHost,
    );
  const parent = crypto.randomUUID(),
    input = {
      room: parent,
      operationId: crypto.randomUUID(),
      settings: {
        ...newRoomSettings(false),
        name: '外部実ルーム',
        public: true,
        capacity: 2,
        source: 'original',
        winMode: 'questions',
        count: 1,
      },
      questions: [
        {
          text: 'テスト問題',
          displayAnswer: 'あ',
          readings: ['あ'],
          explanation: '独自の検証問題',
        },
      ],
    };
  const created = await call('create', input);
  expect(created.status).toBe(200);
  expect((await created.json<{ room: RoomView }>()).room.members).toHaveLength(1);
  expect((await call('create', input)).status).toBe(200);
  expect((await call('join', { ...input, room: crypto.randomUUID() })).status).toBe(409);
  const identity = await resumeParticipation(realHost, session.secret, session.row.id),
    [instance] = await hostDb.select().from(instances).where(eq(instances.id, hostId)),
    [native] = await hostDb
      .select()
      .from(organizationAccounts)
      .where(eq(organizationAccounts.subject, 'host-admin')),
    nativeActor = { id: native.actorId, name: '開催元参加者', guest: false },
    scope = { id: hostId, owner: instance.owner, mode: 'room' as const },
    nativeAdmission = await realHost.MATCHMAKER.getByName('matchmaker').enterRoom(
      nativeActor,
      parent,
      scope,
      {
        operationId: crypto.randomUUID(),
        password: '',
        invite: '',
      },
    );
  if (!nativeAdmission.ok) throw new Error(nativeAdmission.code);
  const lobby = realHost.GAME_ROOM.getByName(`room:${parent}`),
    sockets: WebSocket[] = [];
  let game: typeof lobby | undefined;
  const open = async (stub: typeof lobby, token: string) => {
    const response = await stub.fetch('https://room.test', {
      headers: {
        Upgrade: 'websocket',
        'X-Game-Session': token,
        'X-Game-Instance': hostId,
      },
    });
    if (!response.webSocket) throw new Error(`UPGRADE_${response.status}`);
    response.webSocket.accept();
    sockets.push(response.webSocket);
  };
  try {
    await open(lobby, identity.token);
    await open(lobby, nativeAdmission.token);
    await refreshParticipationAccess(realHost, hostId, [session.row.actorId], true);
    expect(
      (
        await call('mutate', {
          room: parent,
          action: 'ready',
          ready: true,
          operationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      await lobby.mutateUserRoom(nativeActor, {
        action: 'ready',
        ready: true,
        operationId: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: true });
    const view = await (await call('view', { room: parent })).json<{ room: RoomView }>();
    const started = await call('mutate', {
      room: parent,
      action: 'start',
      revision: view.room.revision,
      operationId: crypto.randomUUID(),
    });
    expect(started.status).toBe(200);
    const gameSession = await lobby.userRoomGameSession(
      identity.reservation.actorId,
      identity.token,
    );
    if ('ok' in gameSession) throw new Error(gameSession.code);
    const nativeGame = await lobby.userRoomGameSession(
      nativeActor.id,
      nativeAdmission.token,
    );
    if ('ok' in nativeGame) throw new Error(nativeGame.code);
    game = realHost.GAME_ROOM.getByName(`match:${gameSession.room}`);
    await open(game, gameSession.token);
    await open(game, nativeGame.token);
    let matchId = '';
    await runInDurableObject(game, async (object, context) => {
      const room = await readStored<{ state: State }>(context.storage, 'room');
      if (!room) throw new Error('ROOM_REQUIRED');
      expect(room.state.phase).toBe('REVEALING');
      expect(room.state.parentRoomId).toBe(parent);
      room.state.phase = 'JUDGED';
      room.state.deadline = Date.now() - 1;
      room.state.judgment = { actorId: null, result: 'unanswered' };
      advance(room.state, Date.now());
      matchId = room.state.matchId ?? '';
      await context.storage.transaction((transaction) =>
        writeStored(transaction, 'room', room),
      );
      await object.alarm();
    });
    const [job] = await hostDb
      .select()
      .from(federationResultDeliveries)
      .where(eq(federationResultDeliveries.matchId, matchId));
    expect(job.payload.kind).toBe('room');
    expect(job.payload.players.every((player) => player.ratingDelta === 0)).toBe(true);
    expect(JSON.stringify(job.payload)).not.toContain(input.questions[0].text);
    await deliverResult(realHost, job.eventId);
    expect((await foreignHistory(source, 'source-admin')).history[0]).toMatchObject({
      kind: 'room',
      matchId,
    });
  } finally {
    for (const socket of sockets) socket.close();
    // Stop the test's live lobby before its alarm can outlast the fetch mocks.
    await runInDurableObject(lobby, async (_object, context) => {
      await context.storage.deleteAlarm();
    });
    await evictDurableObject(lobby, { webSockets: 'close' });
    if (game) {
      await runInDurableObject(game, async (_object, context) => {
        await context.storage.deleteAlarm();
      });
      await evictDurableObject(game, { webSockets: 'close' });
    }
    globalThis.fetch = originalFetch;
  }
});
it('所属元の参加停止は新規・待機の再認証を拒否し、開始済みでもチケットを再発行しない', async () => {
  const first = await authorize(),
    session = await exchangeParticipation(host, { ticket: first.ticket });
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .update(federationPeers)
        .set({ participationBlocked: true })
        .where(eq(federationPeers.origin, hostOrigin)),
    );
  });
  await expect(authorize()).rejects.toThrow('FEDERATION_PARTICIPATION_DENIED');
  phase = 'REVEALING';
  await expect(authorize()).rejects.toThrow('FEDERATION_PARTICIPATION_DENIED');
  expect((await participationSession(host, session.secret)).reservation.id).toBe(
    session.row.id,
  );
});
it('終了後も開催元の参加セッションを結果取得に使える', async () => {
  const ticket = await authorize();
  const session = await exchangeParticipation(host, { ticket: ticket.ticket });
  phase = 'FINISHED';
  expect((await participationSession(host, session.secret)).reservation.state).toBe(
    'exchanged',
  );
  expect(cancel).not.toHaveBeenCalled();
});
// The actor's history spans every test, so each test reads only its own result.
const deliveredHistory = async (matchId: string) =>
  (await foreignHistory(source, 'source-admin')).history.filter(
    (entry) => entry.matchId === matchId,
  );
async function savedForeignResult(stopHostReceiving = false) {
  const ticket = await authorize(),
    admission = await exchangeParticipation(host, { ticket: ticket.ticket }),
    { record } = resultFixture();
  record.owner = hostOwner;
  record.matchId = matchId;
  record.startedAt = Date.now() - 1000;
  record.result.finishedAt = Date.now();
  record.result.winnerId = admission.row.actorId;
  record.players = record.players.map((player, index) => ({
    ...player,
    id: index === 0 ? admission.row.actorId : 'c'.repeat(64),
  }));
  record.definition.competition.owner = hostOwner;
  record.definition.ruleset.owner = hostOwner;
  record.definition.questionSet.owner = hostOwner;
  record.completedQuestions = [
    {
      id: 'shown',
      text: '出題済みの本文',
      displayAnswer: '正答',
      readings: ['せいとう'],
      explanation: '解説',
      source: '出典',
      correct: true,
      participants: record.players.map((player) => player.id),
    },
  ];
  if (stopHostReceiving)
    await changeD1(hostDb, async (writes) => {
      writes.push(
        hostDb
          .update(federationPeers)
          .set({ receiveRanked: false })
          .where(eq(federationPeers.origin, sourceOrigin)),
      );
    });
  await commitFixtureResult(runtime.GAME_D1, record);
  const [job] = await hostDb
    .select()
    .from(federationResultDeliveries)
    .where(eq(federationResultDeliveries.matchId, record.matchId));
  return { record, job };
}
it('保存直後の配送障害でも送信記録を残し、再試行で本人履歴へ一度だけ届ける', async () => {
  const { record, job } = await savedForeignResult();
  const dispatch = vi.fn(async () => Response.json({ ready: false }, { status: 503 }));
  const immediateHost = {
    ...host,
    ACCOUNT_ERASURE: { fetch: dispatch },
  } as unknown as Env;
  await expect(dispatchSavedResult(immediateHost, record.matchId)).rejects.toMatchObject({
    code: 'FEDERATION_RESULT_UNAVAILABLE',
  });
  expect(
    (
      await hostDb
        .select()
        .from(federationResultDeliveries)
        .where(eq(federationResultDeliveries.eventId, job.eventId))
    )[0].receivedAt,
  ).toBeNull();
  dispatch.mockImplementation(async () => {
    await deliverResult(host, job.eventId);
    return Response.json({ ready: true });
  });
  await dispatchSavedResult(immediateHost, record.matchId);
  expect(dispatch.mock.calls[1]).toEqual([
    'https://account-erasure.internal/maintenance',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ task: 'federationResult', eventId: job.eventId }),
    }),
  ]);
  await dispatchSavedResult(immediateHost, record.matchId);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(await deliveredHistory(record.matchId)).toHaveLength(1);
});
it('開始後に開催元の受入設定を削除しても、参加済みの本人への結果配送を失わない', async () => {
  const { job } = await savedForeignResult(true);
  await deliverResult(host, job.eventId);
  expect(await deliveredHistory(job.matchId)).toHaveLength(1);
});
it('確定結果を署名して本人履歴へ配送し、所属元レートと未出題情報を混ぜない', async () => {
  const before = await readResults(sourceDb, sourceOwner, actorId, [], {
      section: 'self',
    }),
    { job, record } = await savedForeignResult();
  expect(JSON.stringify(job.payload)).not.toContain('出題済みの本文');
  expect(JSON.stringify(job.payload)).not.toContain('せいとう');
  await deliverResult(host, job.eventId);
  const history = await deliveredHistory(record.matchId);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    peerOrigin: hostOrigin,
    sourceActorId: actorId,
    matchId: record.matchId,
  });
  expect(
    (await readResults(sourceDb, sourceOwner, actorId, [], { section: 'self' })).self,
  ).toEqual(before.self);
  const [saved] = await hostDb
    .select()
    .from(federationResultDeliveries)
    .where(eq(federationResultDeliveries.eventId, job.eventId));
  expect(saved.receivedAt).not.toBeNull();
  expect(saved.appliedAt).not.toBeNull();
  const duplicate = await receiveResultEvent(source, hostOrigin, saved.message);
  expect(duplicate.duplicate).toBe(true);
  expect(
    (
      await hostResultReview(host, sourceOrigin, {
        matchId: record.matchId,
        sourceActorId: actorId,
        sourceOrganizationId: sourceId,
      })
    ).questions[0].text,
  ).toBe('出題済みの本文');
  await expect(
    hostResultReview(host, sourceOrigin, {
      matchId: record.matchId,
      sourceActorId: 'd'.repeat(64),
      sourceOrganizationId: sourceId,
    }),
  ).rejects.toThrow('RESULT_REVIEW_UNAVAILABLE');
});
it('通信断でも原本と未配送を保ち、復旧時に同じイベントを再送する', async () => {
  const { job } = await savedForeignResult(),
    transport = vi.mocked(globalThis.fetch).getMockImplementation();
  vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('offline'));
  await deliverResult(host, job.eventId);
  const [failed] = await hostDb
    .select()
    .from(federationResultDeliveries)
    .where(eq(federationResultDeliveries.eventId, job.eventId));
  expect(failed.receivedAt).toBeNull();
  expect(failed.quarantined).toBe(false);
  expect(failed.nextAttemptAt).toBeGreaterThan(Date.now());
  if (transport) vi.mocked(globalThis.fetch).mockImplementation(transport);
  const dispatched: string[] = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 3600000);
  try {
    await scheduledD1(
      {
        ...host,
        ACCOUNT_ERASURE: {
          fetch: async (_url: string, init: RequestInit) => {
            const task = JSON.parse(String(init.body));
            if (task.task === 'federationResult') {
              dispatched.push(task.eventId);
              await deliverResult(host, task.eventId);
            }
            return Response.json({ ok: true });
          },
        } as Fetcher,
      },
      Date.now(),
      'hourly',
    );
  } finally {
    vi.useRealTimers();
  }
  expect(dispatched).toContain(job.eventId);
  const [saved] = await hostDb
    .select()
    .from(federationResultDeliveries)
    .where(eq(federationResultDeliveries.eventId, job.eventId));
  expect(saved.message).toBe(failed.message);
  expect(saved.payloadHash).toBe(failed.payloadHash);
  expect(saved.receivedAt).not.toBeNull();
  await deliverResult(host, job.eventId);
  vi.mocked(globalThis.fetch).mockRejectedValue(new Error('offline'));
  expect(await deliveredHistory(job.matchId)).toHaveLength(1);
});
it('同一イベントの別内容を409で隔離し、既に受信した原本を更新しない', async () => {
  const { job } = await savedForeignResult();
  await deliverResult(host, job.eventId);
  const changed = { ...job.payload, hostInstanceName: '改変' };
  await expect(
    receiveResultEvent(source, hostOrigin, await signEvent(host, changed)),
  ).rejects.toThrow('FEDERATION_RESULT_CONFLICT');
  const [row] = await sourceDb
    .select()
    .from(federationResultInbox)
    .where(eq(federationResultInbox.eventId, job.eventId));
  expect(row.payload).toEqual(job.payload);
  expect(row.conflictHash).not.toBeNull();
});
it('開催元のログアウトと再認証は許可IDで旧Cookieを失効させる', async () => {
  const first = await authorize();
  const session = await exchangeParticipation(host, { ticket: first.ticket });
  const oldAuthorization = session.row.authorizationId;
  phase = 'REVEALING';
  await logoutHostParticipation(host, sourceOrigin, {
    operationId,
    sourceActorId: actorId,
    authorizationId: oldAuthorization,
  });
  await expect(participationSession(host, session.secret)).rejects.toThrow(
    'SESSION_REQUIRED',
  );
  const renewed = await authorize();
  await expect(exchangeParticipation(host, { ticket: first.ticket })).rejects.toThrow(
    'PARTICIPATION_TICKET_REPLAY',
  );
  const resumed = await exchangeParticipation(host, { ticket: renewed.ticket });
  expect(resumed.row.id).toBe(session.row.id);
  expect(resumed.row.authorizationId).not.toBe(oldAuthorization);
  await logoutHostParticipation(host, sourceOrigin, {
    operationId,
    sourceActorId: actorId,
    authorizationId: oldAuthorization,
  });
  expect((await participationSession(host, resumed.secret)).reservation.id).toBe(
    session.row.id,
  );
});

it('別試合の参加許可を流用せず、Cookieの予約名を付け替えても別予約を操作しない', async () => {
  const result = await authorize(),
    session = await exchangeParticipation(host, { ticket: result.ticket });
  expect(
    await allowedInstanceActors(
      host,
      { id: hostId, owner: hostOwner },
      [session.row.actorId],
      crypto.randomUUID(),
    ),
  ).toEqual([]);
  await expect(
    resumeParticipation(host, session.secret, crypto.randomUUID()),
  ).rejects.toThrow('SESSION_REQUIRED');
});

it('両側の許可・実署名を通して予約し、一度だけ開催セッションへ交換する', async () => {
  const result = await authorize(),
    claims = await verifyParticipationTicket(host, result.ticket);
  expect(claims).toMatchObject({
    iss: sourceOrigin,
    sub: actorId,
    aud: hostOrigin,
    sourceOrganizationId: sourceId,
    hostInstanceId: hostId,
    mode: 'ranked',
    matchId,
  });
  const session = await exchangeParticipation(host, { ticket: result.ticket });
  expect((await participationSession(host, session.secret)).reservation.state).toBe(
    'exchanged',
  );
  expect((await resumeParticipation(host, session.secret)).reservation.id).toBe(
    claims.reservationId,
  );
  await expect(exchangeParticipation(host, { ticket: result.ticket })).rejects.toThrow(
    'PARTICIPATION_TICKET_REPLAY',
  );
  const mapping = (
      await hostDb
        .select()
        .from(federationActors)
        .where(eq(federationActors.actorId, session.row.actorId))
    )[0],
    account = (
      await hostDb
        .select()
        .from(organizationAccounts)
        .where(eq(organizationAccounts.actorId, mapping.actorId))
    )[0];
  expect(mapping.sourceActorId).toBe(actorId);
  expect(account.administrator).toBe(false);
  expect(account.displayName).toBeNull();
  expect(JSON.stringify(claims)).not.toContain('server-only-session-token');
  const sessions = await hostDb
    .select()
    .from(federationSessions)
    .where(eq(federationSessions.reservationId, session.row.id));
  expect(sessions).toHaveLength(1);
  expect(JSON.stringify(sessions)).not.toContain(session.secret);
});
it('応答消失後に同じ操作を再送しても予約は増えず、内容変更は拒否する', async () => {
  const first = await reserveParticipation(host, sourceOrigin, request()),
    again = await reserveParticipation(host, sourceOrigin, request());
  expect(again.reservationId).toBe(first.reservationId);
  expect(enter).toHaveBeenLastCalledWith(
    expect.any(String),
    '参加者',
    false,
    expect.any(Object),
    false,
    operationId,
    '所属元',
  );
  expect(
    await hostDb
      .select()
      .from(federationReservations)
      .where(
        and(
          eq(federationReservations.peerOrigin, sourceOrigin),
          eq(federationReservations.operationId, operationId),
        ),
      ),
  ).toHaveLength(1);
  await expect(
    reserveParticipation(host, sourceOrigin, { ...request(), displayName: '別人' }),
  ).rejects.toThrow('OPERATION_CONFLICT');
});
it('受入取消と所属元停止を待機へ反映し、復旧後だけ再び許可する', async () => {
  const result = await authorize(),
    session = await exchangeParticipation(host, { ticket: result.ticket }),
    row = session.row,
    scope = { id: hostId, owner: hostOwner };
  expect(await allowedInstanceActors(host, scope, [row.actorId])).toEqual([row.actorId]);
  const blockHost = (participationBlocked: boolean) =>
    changeD1(sourceDb, async (writes) => {
      writes.push(
        sourceDb
          .update(federationPeers)
          .set({ participationBlocked })
          .where(eq(federationPeers.origin, hostOrigin)),
      );
    });
  await blockHost(true);
  await refreshParticipationAccess(host, hostId, [row.actorId], true);
  expect(await allowedInstanceActors(host, scope, [row.actorId])).toEqual([]);
  await blockHost(false);
  await refreshParticipationAccess(host, hostId, [row.actorId], true);
  expect(await allowedInstanceActors(host, scope, [row.actorId])).toEqual([row.actorId]);
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .update(federationPeers)
        .set({ receiveRanked: false })
        .where(eq(federationPeers.origin, sourceOrigin)),
    );
  });
  expect(await allowedInstanceActors(host, scope, [row.actorId])).toEqual([]);
  await expect(authorize()).rejects.toThrow('FEDERATION_PEER_UNAVAILABLE');
});
it('別試合・別対象・期限切れの参加券を交換しない', async () => {
  const result = await authorize(),
    ticket = await verifyParticipationTicket(host, result.ticket);
  const { keyRevision: _keyRevision, ...claims } = ticket;
  await expect(
    exchangeParticipation(host, {
      ticket: await signParticipationTicket(source, {
        ...claims,
        matchId: crypto.randomUUID(),
        jti: crypto.randomUUID(),
      }),
    }),
  ).rejects.toThrow('PARTICIPATION_TICKET_BINDING');
  await expect(verifyParticipationTicket(source, result.ticket)).rejects.toThrow(
    'PARTICIPATION_TICKET_REJECTED',
  );
  const now = Math.floor(Date.now() / 1000);
  await expect(
    verifyParticipationTicket(
      host,
      await signParticipationTicket(source, {
        ...claims,
        iat: now - 120,
        exp: now - 60,
        jti: crypto.randomUUID(),
      }),
    ),
  ).rejects.toThrow('PARTICIPATION_TICKET_REJECTED');
});
it('所属元の取得失敗は待機を閉じ、既に交換した開始済みセッションは再接続できる', async () => {
  const result = await authorize(),
    session = await exchangeParticipation(host, { ticket: result.ticket });
  vi.mocked(globalThis.fetch).mockRejectedValue(new Error('offline'));
  await expect(
    refreshParticipationAccess(host, hostId, [session.row.actorId], true),
  ).rejects.toThrow('FEDERATION_PEER_UNAVAILABLE');
  expect(
    await allowedInstanceActors(host, { id: hostId, owner: hostOwner }, [
      session.row.actorId,
    ]),
  ).toEqual([]);
  phase = 'REVEALING';
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .update(federationPeers)
        .set({ approved: false, revision: 2 })
        .where(eq(federationPeers.origin, sourceOrigin)),
    );
  });
  expect((await resumeParticipation(host, session.secret)).reservation.matchId).toBe(
    matchId,
  );
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .update(federationPeers)
        .set({ approved: true, revision: 3 })
        .where(eq(federationPeers.origin, sourceOrigin)),
    );
  });
});
it('通常WorkerがSecure・HttpOnly・Strict Cookieを発行し、秘密をJSONへ返さない', async () => {
  const result = await authorize();
  const exchange = await app.request(
    `${hostOrigin}/api/v1/participation/exchange`,
    {
      method: 'POST',
      headers: { Origin: hostOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: result.ticket }),
    },
    host,
  );
  expect(exchange.status).toBe(200);
  const data = (await exchange.json()) as { reservationId: string },
    cookie = exchange.headers.get('Set-Cookie') ?? '';
  expect(Object.keys(data)).toEqual(['reservationId']);
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Path=/api;');
  expect(cookie).toContain('SameSite=Strict');
  const view = await app.request(
    `${hostOrigin}/api/v1/participation/session?reservation=${data.reservationId}`,
    {
      method: 'POST',
      headers: { Origin: hostOrigin, Cookie: cookie.split(';')[0] },
      body: '{}',
    },
    host,
  );
  expect(view.status).toBe(200);
  expect(await view.json()).toMatchObject({ name: '参加者', room: roomId });
  const rejected = await app.request(
    `${hostOrigin}/api/v1/participation/session?reservation=${data.reservationId}`,
    {
      method: 'POST',
      headers: { Origin: 'https://untrusted.example', Cookie: cookie.split(';')[0] },
      body: '{}',
    },
    host,
  );
  expect(rejected.status).toBe(403);
});

it('期限切れは2件ずつ停止し、停止RPC失敗後も原本と未確認の取消を保持して再試行する', async () => {
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    operationId = crypto.randomUUID();
    roomId = crypto.randomUUID();
    matchId = crypto.randomUUID();
    const { ticket } = await authorize();
    const value = await exchangeParticipation(host, { ticket });
    ids.push(value.row.id);
  }
  await changeD1(hostDb, async (writes) => {
    for (const id of ids)
      writes.push(
        hostDb
          .update(federationReservations)
          .set({ sessionExpiresAt: 1 })
          .where(eq(federationReservations.id, id)),
      );
    writes.push(hostDb.update(federationSessions).set({ expiresAt: 1 }));
  });
  cancel.mockResolvedValueOnce({ ok: false, code: 'GAME_DATABASE_UNAVAILABLE' });
  await expect(expireHostParticipations(host)).rejects.toThrow(
    'PARTICIPATION_RELEASE_PENDING',
  );
  const rows = await hostDb.select().from(federationReservations);
  expect(
    rows.filter((row) => ids.includes(row.id) && row.state === 'closed'),
  ).toHaveLength(1);
  await expireHostParticipations(host);
  expect(
    (await hostDb.select().from(federationReservations)).filter(
      (row) => ids.includes(row.id) && row.state === 'closed',
    ),
  ).toHaveLength(3);
  await expireFederationSessions(host);
  expect(await hostDb.select().from(federationSessions)).toHaveLength(0);
});

async function loginProof() {
  const [organization] = await sourceDb.select().from(organizations);
  const target = {
    peerOrigin: hostOrigin,
    sourceOrganizationId: organization.id,
    hostInstanceId: hostId,
    mode: 'ranked' as const,
    state: crypto.randomUUID(),
  };
  const { ticket } = await authorizeForeignLogin(source, 'source-admin', target);
  return { ...target, peerOrigin: sourceOrigin, ticket };
}
it('外部ログインだけでは予約・参加者・所属元の参加履歴を作らず、本人・所属組織をCookieで保持する', async () => {
  const before = await hostDb.select().from(organizationAccounts);
  const beforeReservations = await hostDb.select().from(federationReservations),
    beforeHistory = await sourceDb.select().from(federationParticipations);
  const proof = await loginProof();
  const response = await app.request(
    `${hostOrigin}/api/v1/participation/login/exchange`,
    {
      method: 'POST',
      headers: { Origin: hostOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify(proof),
    },
    host,
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({
    account: { name: '参加者', organizationName: '所属元', homeOrigin: sourceOrigin },
  });
  expect(result).not.toHaveProperty('secret');
  const cookie = response.headers.get('Set-Cookie') ?? '';
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Path=/api;');
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('SameSite=Strict');
  expect(await hostDb.select().from(organizationAccounts)).toEqual(before);
  expect(await hostDb.select().from(federationReservations)).toEqual(beforeReservations);
  expect(await sourceDb.select().from(federationParticipations)).toEqual(beforeHistory);
  expect(enter).not.toHaveBeenCalled();
  const view = await app.request(
    `${hostOrigin}/api/v1/participation/login/session`,
    {
      method: 'POST',
      headers: { Origin: hostOrigin, Cookie: cookie.split(';')[0] },
      body: '{}',
    },
    host,
  );
  expect(view.status).toBe(200);
  expect(await view.json()).toMatchObject({
    instances: expect.arrayContaining([
      expect.objectContaining({ id: hostId, ranked: true }),
    ]),
  });
});
it('外部ログイン証明のstate・所属元・対象・種別の取り違えと再利用を拒否する', async () => {
  const proof = await loginProof();
  for (const changed of [
    { state: crypto.randomUUID() },
    { hostInstanceId: crypto.randomUUID() },
    { sourceOrganizationId: crypto.randomUUID() },
    { mode: 'casual' },
  ])
    await expect(exchangeForeignLogin(host, { ...proof, ...changed })).rejects.toThrow(
      'PARTICIPATION_TICKET_BINDING',
    );
  await exchangeForeignLogin(host, proof);
  await expect(exchangeForeignLogin(host, proof)).rejects.toThrow(
    'PARTICIPATION_TICKET_REPLAY',
  );
  await expect(exchangeParticipation(host, { ticket: proof.ticket })).rejects.toThrow(
    'PARTICIPATION_TICKET_REJECTED',
  );
});
it('開催元の未承認・明示禁止・対戦種別の制限は外部ログインでも確認する', async () => {
  const proof = await loginProof();
  for (const change of [
    { approved: false },
    { approved: true, participationBlocked: true },
    { participationBlocked: false, receiveRanked: false },
  ]) {
    await changeD1(hostDb, async (writes) => {
      writes.push(
        hostDb
          .update(federationPeers)
          .set(change)
          .where(eq(federationPeers.origin, sourceOrigin)),
      );
    });
    await expect(exchangeForeignLogin(host, proof)).rejects.toThrow(
      'FEDERATION_PARTICIPATION_DENIED',
    );
  }
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb.update(federationPeers).set({ receiveRanked: true, approved: false }),
      hostDb.update(organizations).set({ externalParticipation: 'unblocked' }),
    );
  });
  expect((await exchangeForeignLogin(host, proof)).row.sourceActorId).toBe(actorId);
});
it('開催元だけのログアウトで開催元のCookieを失効させ、所属元のアカウントと別人のログインを保つ', async () => {
  const login = await exchangeForeignLogin(host, await loginProof());
  const other = {
    ...login.row,
    hash: 'other-user-session',
    sourceActorId: 'f'.repeat(64),
  };
  await changeD1(hostDb, async (writes) => {
    writes.push(hostDb.insert(federationLoginSessions).values(other));
  });
  sourceId = login.row.sourceOrganizationId;
  const { ticket } = await authorize();
  const participation = await exchangeParticipation(host, { ticket });
  operationId = crypto.randomUUID();
  const unused = await authorize();
  const creating = {
    ...participation.row,
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    state: 'creating' as const,
    roomId: null,
    matchId: null,
    sessionExpiresAt: 0,
    expiresAt: Date.now() + 60000,
  };
  await changeD1(hostDb, async (writes) => {
    writes.push(hostDb.insert(federationReservations).values(creating));
  });
  const before = (await sourceDb.select().from(organizationAccounts)).find(
    (row) => row.actorId === actorId,
  );
  await logoutForeignLogin(host, login.secret);
  await expect(foreignLoginSession(host, login.secret)).rejects.toThrow(
    'SESSION_REQUIRED',
  );
  expect(
    await hostDb
      .select()
      .from(federationSessions)
      .where(eq(federationSessions.reservationId, participation.row.id)),
  ).toHaveLength(0);
  expect(await hostDb.select().from(federationLoginSessions)).toEqual([other]);
  expect(
    (await sourceDb.select().from(organizationAccounts)).find(
      (row) => row.actorId === actorId,
    ),
  ).toEqual(before);
  expect(cancel).toHaveBeenCalledWith(expect.any(String), roomId, true, hostId, false);
  await expect(exchangeParticipation(host, { ticket: unused.ticket })).rejects.toThrow();
  expect(cancelAdmission).toHaveBeenCalledWith(
    creating.actorId,
    creating.operationId,
    hostId,
    undefined,
  );
  expect(
    (
      await hostDb
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.id, creating.id))
    )[0].state,
  ).toBe('closed');
});
it('ログインCookieの交換・参照・ログアウトは別Originから行えない', async () => {
  const proof = await loginProof();
  const before = await hostDb.select().from(federationLoginSessions);
  for (const action of ['exchange', 'session', 'logout']) {
    const response = await app.request(
      `${hostOrigin}/api/v1/participation/login/${action}`,
      {
        method: 'POST',
        headers: { Origin: sourceOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'exchange' ? proof : {}),
      },
      host,
    );
    expect(response.status).toBe(403);
  }
  expect(await hostDb.select().from(federationLoginSessions)).toEqual(before);
});
it('外部ログインで部屋の一覧・選択肢・本人セットを閲覧しても参加予約や会員を作らない', async () => {
  const login = await exchangeForeignLogin(host, await loginProof()),
    beforeAccounts = await hostDb.select().from(organizationAccounts),
    beforeReservations = await hostDb.select().from(federationReservations);
  for (const action of ['list', 'options', 'sets', 'create', 'join']) {
    const response = await app.request(
      `${hostOrigin}/api/v1/participation/login/rooms/${action}`,
      {
        method: 'POST',
        headers: {
          Origin: hostOrigin,
          Cookie: `qr_foreign_login=${login.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ instanceId: hostId }),
      },
      host,
    );
    expect(response.status).toBe(['create', 'join'].includes(action) ? 400 : 200);
  }
  expect(await hostDb.select().from(organizationAccounts)).toEqual(beforeAccounts);
  expect(await hostDb.select().from(federationReservations)).toEqual(beforeReservations);
  expect(enter).not.toHaveBeenCalled();
});
it('外部ログインCookieと別人の参加証明を混ぜても参加Cookieを発行しない', async () => {
  const login = await exchangeForeignLogin(host, await loginProof());
  sourceId = login.row.sourceOrganizationId;
  const { ticket } = await authorize(),
    proof = await verifyParticipationTicket(host, ticket);
  const { keyRevision: _, ...claims } = proof;
  const changed = await signParticipationTicket(source, {
    ...claims,
    sub: 'f'.repeat(64),
    jti: crypto.randomUUID(),
  });
  const response = await app.request(
    `${hostOrigin}/api/v1/participation/exchange`,
    {
      method: 'POST',
      headers: {
        Origin: hostOrigin,
        Cookie: `qr_foreign_login=${login.secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ticket: changed }),
    },
    host,
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: 'PARTICIPATION_TICKET_BINDING' });
  expect(response.headers.get('Set-Cookie')).toBeNull();
});

beforeEach(resetMatchmaker);

it('参加Cookieで確定済みの本人の結果をD1から読み、他人の結果を返さない', async () => {
  const ticket = await authorize();
  const session = await exchangeParticipation(host, { ticket: ticket.ticket });
  const { record } = resultFixture();
  record.owner = hostOwner;
  for (const key of ['competition', 'ruleset', 'questionSet'] as const)
    record.definition[key].owner = hostOwner;
  record.players[0].id = session.row.actorId;
  record.players[0].disqualified = true;
  record.players[0].forfeited = true;
  record.result.winnerId = record.players[1].id;
  await commitFixtureResult(runtime.GAME_D1, record);
  const response = await app.fetch(
    new Request(
      `${hostOrigin}/api/play/results?instance=${hostId}&reservation=${session.row.id}`,
      {
        method: 'POST',
        headers: {
          Origin: hostOrigin,
          'Content-Type': 'application/json',
          Cookie: `qr_fed_${session.row.id}=${session.secret}`,
        },
        body: JSON.stringify({ section: 'history', matchId: record.matchId }),
      },
    ),
    host,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    actorId: session.row.actorId,
    history: [
      {
        snapshot: {
          matchId: record.matchId,
          questionCount: record.questionCount,
          result: { storage: 'confirmed' },
          players: [
            { id: session.row.actorId, disqualified: true, forfeited: true },
            { id: record.players[1].id },
          ],
        },
      },
    ],
  });
});

it('認可と発行を分け、合計5秒を超えても開催先への入れ子通信なしで参加できる', async () => {
  const login = await exchangeForeignLogin(host, await loginProof());
  vi.mocked(fetch).mockImplementation(async (request, options) => {
    const url = new URL((request as Request).url);
    expect(url.origin).toBe(sourceOrigin);
    if (url.pathname === '/federation/v1/participation/authorize') {
      await new Promise((resolve) => setTimeout(resolve, 2700));
      options?.signal?.throwIfAborted();
    }
    return app.request(
      request as Request,
      undefined,
      url.origin === hostOrigin ? host : source,
    );
  });
  const response = await app.request(
    `${hostOrigin}/api/v1/participation/login/join`,
    {
      method: 'POST',
      headers: { Origin: hostOrigin, Cookie: `qr_foreign_login=${login.secret}` },
      body: JSON.stringify({
        hostInstanceId: hostId,
        mode: 'ranked',
        operationId: crypto.randomUUID(),
      }),
    },
    host,
  );
  expect(response.status).toBe(200);
  expect((await response.json()) as { sourceActorId: string }).toMatchObject({
    sourceActorId: actorId,
  });
});

it('発行応答を失っても同じ操作の再試行は予約と所属元履歴の照合記録を重複させない', async () => {
  const login = await exchangeForeignLogin(host, await loginProof());
  let authorizations = 0;
  vi.mocked(fetch).mockImplementation(async (request) => {
    const url = new URL((request as Request).url);
    const response = await app.request(
      request as Request,
      undefined,
      url.origin === hostOrigin ? host : source,
    );
    if (
      url.pathname === '/federation/v1/participation/authorize' &&
      ++authorizations === 2
    )
      throw new Error('RESPONSE_LOST');
    return response;
  });
  const input = { hostInstanceId: hostId, mode: 'ranked', operationId };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(joinForeignLogin(host, login.secret, input)).rejects.toThrow(
      'FEDERATION_PEER_UNAVAILABLE',
    );
    const diagnostic = log.mock.calls
      .map(([line]) => JSON.parse(line))
      .find((entry) => entry.event === 'federation_join_failed');
    expect(diagnostic).toMatchObject({
      operationId,
      stage: 'home.issue',
      code: 'FEDERATION_PEER_UNAVAILABLE',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(login.secret);
  } finally {
    log.mockRestore();
  }
  const reservations = await hostDb
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.operationId, operationId));
  expect(reservations).toHaveLength(1);
  expect(
    await hostDb
      .select()
      .from(federationSessions)
      .where(eq(federationSessions.reservationId, reservations[0].id)),
  ).toHaveLength(0);
  const joined = await joinForeignLogin(host, login.secret, input);
  expect(joined.row.operationId).toBe(operationId);
  expect(
    await hostDb
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.operationId, operationId)),
  ).toHaveLength(1);
  expect(
    await sourceDb
      .select()
      .from(federationParticipations)
      .where(eq(federationParticipations.reservationId, joined.row.id)),
  ).toHaveLength(1);
  expect(
    await hostDb
      .select()
      .from(federationSessions)
      .where(eq(federationSessions.reservationId, joined.row.id)),
  ).toHaveLength(1);
});

it('ログアウト中に新しい参加が確定した場合は完了を返さず、再試行で両方を失効させる', async () => {
  const login = await exchangeForeignLogin(host, await loginProof());
  const first = await joinForeignLogin(host, login.secret, {
    hostInstanceId: hostId,
    mode: 'ranked',
    operationId,
  });
  let second: Awaited<ReturnType<typeof joinForeignLogin>> | undefined;
  cancel.mockImplementationOnce(async () => {
    matchId = crypto.randomUUID();
    roomId = crypto.randomUUID();
    second = await joinForeignLogin(host, login.secret, {
      hostInstanceId: hostId,
      mode: 'ranked',
      operationId: crypto.randomUUID(),
    });
    return { ok: true };
  });
  await expect(logoutForeignLogin(host, login.secret)).rejects.toThrow(
    'PARTICIPATION_LOGOUT_PENDING',
  );
  expect(second).toBeDefined();
  await logoutForeignLogin(host, login.secret);
  await expect(foreignLoginSession(host, login.secret)).rejects.toThrow(
    'SESSION_REQUIRED',
  );
  if (!second) throw new Error('CONCURRENT_JOIN_MISSING');
  for (const participation of [first, second]) {
    expect(
      await hostDb
        .select()
        .from(federationSessions)
        .where(eq(federationSessions.reservationId, participation.row.id)),
    ).toHaveLength(0);
    const [row] = await hostDb
      .select()
      .from(federationReservations)
      .where(eq(federationReservations.id, participation.row.id));
    expect(row.state).toBe('closed');
  }
});

it('交換前に失効した外部ログインから参加セッションを作らない', async () => {
  const login = await exchangeForeignLogin(host, await loginProof());
  const ticket = await authorize();
  const [reservation] = await hostDb
    .select()
    .from(federationReservations)
    .where(eq(federationReservations.operationId, operationId));
  await changeD1(hostDb, async (writes) => {
    writes.push(hostDb.delete(federationLoginSessions));
  });
  await expect(exchangeParticipation(host, ticket, login.secret)).rejects.toThrow(
    'INVALID_PARTICIPATION',
  );
  await expect(
    exchangeParticipation(host, { ticket: ticket.ticket }, login.secret),
  ).rejects.toThrow('SESSION_REQUIRED');
  expect(
    await hostDb
      .select()
      .from(federationSessions)
      .where(eq(federationSessions.reservationId, reservation.id)),
  ).toHaveLength(0);
});

it('同じ外部ログインCookieで再ログインせず次の対戦へ参加し、所属元の記録を残す', async () => {
  const login = await exchangeForeignLogin(host, await loginProof());
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const response = await app.request(
      `${hostOrigin}/api/v1/participation/login/join`,
      {
        method: 'POST',
        headers: { Origin: hostOrigin, Cookie: `qr_foreign_login=${login.secret}` },
        body: JSON.stringify({
          hostInstanceId: hostId,
          mode: 'ranked',
          operationId: crypto.randomUUID(),
        }),
      },
      host,
    );
    expect(response.status).toBe(200);
    const session = (await response.json()) as {
      reservationId: string;
      sourceActorId: string;
    };
    expect(session.sourceActorId).toBe(actorId);
    expect(session).not.toHaveProperty('grant');
    ids.push(session.reservationId);
    const cancelled = await app.request(
      `${hostOrigin}/api/v1/participation/cancel?reservation=${session.reservationId}`,
      {
        method: 'POST',
        headers: {
          Origin: hostOrigin,
          Cookie: String(response.headers.get('Set-Cookie')).split(';')[0],
        },
        body: JSON.stringify({ forfeit: false }),
      },
      host,
    );
    expect(cancelled.status).toBe(200);
    matchId = crypto.randomUUID();
    roomId = crypto.randomUUID();
  }
  expect(new Set(ids).size).toBe(2);
  const records = await sourceDb.select().from(federationParticipations);
  expect(records.filter((record) => ids.includes(record.reservationId))).toHaveLength(2);
  expect((await foreignLoginSession(host, login.secret)).sourceActorId).toBe(actorId);
  const rejected = await app.request(
    `${hostOrigin}/api/v1/participation/login/join`,
    {
      method: 'POST',
      headers: { Origin: sourceOrigin, Cookie: `qr_foreign_login=${login.secret}` },
      body: JSON.stringify({
        hostInstanceId: hostId,
        mode: 'ranked',
        operationId: crypto.randomUUID(),
      }),
    },
    host,
  );
  expect(rejected.status).toBe(403);
});
it('継続参加の証明は開催先・署名・期限を検証し、現在の禁止と退会を優先する', async () => {
  const login = await exchangeForeignLogin(host, await loginProof());
  const input = {
    grant: login.row.grant,
    phase: 'prepare',
    hostInstanceId: hostId,
    mode: 'ranked',
    operationId,
  };
  await expect(
    verifyParticipationGrant(source, sourceOrigin, input.grant),
  ).rejects.toThrow('FOREIGN_LOGIN_EXPIRED');
  await expect(
    verifyParticipationGrant(source, hostOrigin, `${input.grant.slice(0, -8)}AAAAAAAA`),
  ).rejects.toThrow('FOREIGN_LOGIN_EXPIRED');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 43210000);
  await expect(verifyParticipationGrant(source, hostOrigin, input.grant)).rejects.toThrow(
    'FOREIGN_LOGIN_EXPIRED',
  );
  vi.useRealTimers();
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .update(federationPeers)
        .set({ participationBlocked: true })
        .where(eq(federationPeers.origin, hostOrigin)),
    );
  });
  await expect(authorizeSessionParticipation(source, hostOrigin, input)).rejects.toThrow(
    'FEDERATION_PARTICIPATION_DENIED',
  );
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .update(federationPeers)
        .set({ participationBlocked: false })
        .where(eq(federationPeers.origin, hostOrigin)),
      sourceDb
        .update(organizationAccounts)
        .set({ withdrawnAt: new Date().toISOString() })
        .where(eq(organizationAccounts.actorId, actorId)),
    );
  });
  await expect(authorizeSessionParticipation(source, hostOrigin, input)).rejects.toThrow(
    'ACCOUNT_WITHDRAWN',
  );
  const denied = await app.request(
    `${hostOrigin}/api/v1/participation/login/join`,
    {
      method: 'POST',
      headers: { Origin: hostOrigin, Cookie: `qr_foreign_login=${login.secret}` },
      body: JSON.stringify({ hostInstanceId: hostId, mode: 'ranked', operationId }),
    },
    host,
  );
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ code: 'ACCOUNT_WITHDRAWN' });
});
