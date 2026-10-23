import {
  applyD1Migrations,
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it, vi } from 'vitest';
import { eraseInstance } from '../src/erasure/instances';
import { newRoomSettings } from '../src/shared/rooms';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import {
  federationMetadataJobs,
  federationPeers,
  instanceDeletions,
  instanceRooms,
  instances,
  matches,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import {
  addInstance,
  organizationIdentity,
  setupOrganization,
} from '../src/worker/organization/database';
import { cancelMatch, registerMatch, startMatch } from '../src/worker/results/lifecycle';
import { RoomLobby } from '../src/worker/rooms/RoomLobby';
import { resultFixture } from './fixtures/result';

const runtime = env as unknown as Env & {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '開始と削除の競合',
    instanceName: '初期対象',
  });
});
async function target() {
  const id = crypto.randomUUID();
  await addInstance(db, 'admin', { id, name: `対象${id.slice(0, 8)}` });
  const [instance] = await db.select().from(instances).where(eq(instances.id, id));
  return { instance };
}
async function deletion(instance: typeof instances.$inferSelect) {
  const { account } = await organizationIdentity(db, 'admin');
  const id = crypto.randomUUID();
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ state: 'archived' })
        .where(eq(instances.id, instance.id)),
      db.insert(instanceDeletions).values({
        id,
        instanceId: instance.id,
        organizationId: instance.organizationId,
        owner: instance.owner,
        name: instance.name,
        operatorId: account.actorId,
      }),
    );
  });
  return id;
}
async function waitingMatch() {
  const { instance } = await target();
  const { record } = resultFixture();
  record.owner = instance.owner;
  record.definition.competition.owner = instance.owner;
  record.definition.ruleset.owner = instance.owner;
  record.definition.questionSet.owner = instance.owner;
  const waiting = { ...record, result: null, startedAt: null };

  await registerMatch(
    runtime as Env,
    { id: instance.id, owner: instance.owner },
    waiting,
  );
  return { instance, starting: { ...waiting, startedAt: record.startedAt } };
}
async function parentLobby(instance: typeof instances.$inferSelect) {
  const id = crypto.randomUUID();
  const stub = runtime.GAME_ROOM.getByName(`room:${id}`);
  const { account } = await organizationIdentity(db, 'admin');
  const actor = {
    id: account.actorId,
    name: '管理者',
    serverName: '所属元',
    guest: false,
  };
  const scope = { id: instance.id, owner: instance.owner, mode: 'room' as const };
  expect(
    await stub.createUserRoom(id, scope, actor, {
      settings: { ...newRoomSettings(true), name: '検証部屋', capacity: 2 },
    }),
  ).toMatchObject({ ok: true });
  return { id, stub, actor, scope };
}

it.each([
  ['status', false],
  ['status', true],
  ['cancel', false],
  ['cancel', true],
] as const)(
  '解放後の親ロビーへの取消・失効の再送で状態を再作成しない 先行処理=%s 失効=%s',
  async (first, revoke) => {
    const { instance } = await target();
    const parent = await parentLobby(instance);
    const generation = crypto.randomUUID();
    const token = crypto.randomUUID();
    expect(
      await parent.stub.joinUserRoom(
        parent.actor,
        token,
        generation,
        '',
        '',
        parent.scope,
      ),
    ).toMatchObject({ ok: true });
    const operationId = await deletion(instance);
    expect(await eraseInstance(db, operationId)).toBe(false);
    expect(await eraseInstance(db, operationId)).toBe(true);
    if (first === 'status') expect(await parent.stub.lobbyStatus()).toBeNull();
    else
      expect(
        await parent.stub.cancelReservation(
          'room',
          parent.actor.id,
          revoke,
          generation,
          token,
        ),
      ).toBe(true);
    await runInDurableObject(parent.stub, async (_, context) => {
      expect((await context.storage.list()).size).toBe(0);
    });
    await evictDurableObject(parent.stub);
    expect(
      await parent.stub.cancelReservation(
        'room',
        parent.actor.id,
        revoke,
        generation,
        token,
      ),
    ).toBe(true);
    await runInDurableObject(parent.stub, async (_, context) => {
      expect(await context.storage.getAlarm()).toBeNull();
      expect((await context.storage.list()).size).toBe(0);
    });
  },
);

it('Matchmakerの状態確認と取消で削除済み親ロビーの記録を復活させない', async () => {
  const { instance } = await target();
  const parent = await parentLobby(instance);
  const queue = runtime.MATCHMAKER.getByName(`cleanup:${crypto.randomUUID()}`);
  expect(
    await queue.enterRoom(parent.actor, parent.id, parent.scope, {
      operationId: crypto.randomUUID(),
      password: '',
      invite: '',
    }),
  ).toMatchObject({ ok: true });
  const operationId = await deletion(instance);
  expect(await eraseInstance(db, operationId)).toBe(false);
  expect(await eraseInstance(db, operationId)).toBe(true);
  await queue.refreshWaiting(parent.actor.id, instance.id);
  await runInDurableObject(queue, async (_, context) => {
    const saved = await context.storage.get<{ actors: Record<string, unknown> }>('queue');
    expect(saved?.actors[parent.actor.id]).toBeUndefined();
  });
  await runInDurableObject(parent.stub, async (_, context) => {
    expect((await context.storage.list()).size).toBe(0);
    expect(await context.storage.getAlarm()).toBeNull();
  });
});

it('取消の再検査前に完全削除されても親ロビーの記録を復活させない', async () => {
  const { instance } = await target();
  const parent = await parentLobby(instance);
  await runInDurableObject(parent.stub, async (_, context) => {
    const lobby = new RoomLobby(context, runtime);
    const read = lobby.read.bind(lobby);
    let reads = 0;
    const spy = vi.spyOn(lobby, 'read').mockImplementation(async () => {
      if (++reads === 2) {
        const operationId = await deletion(instance);
        expect(await eraseInstance(db, operationId)).toBe(false);
        expect(await eraseInstance(db, operationId)).toBe(true);
      }
      return read();
    });
    try {
      expect(
        await lobby.cancel(
          parent.actor.id,
          false,
          crypto.randomUUID(),
          crypto.randomUUID(),
        ),
      ).toBe(true);
      expect(reads).toBe(2);
      expect((await context.storage.list()).size).toBe(0);
      expect(await context.storage.getAlarm()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

it.each(['archived', 'accepted'])(
  '非公開化・削除受付後に遅延した試合開始を拒否する %s',
  async (stage) => {
    const { instance, starting } = await waitingMatch();
    if (stage === 'accepted') {
      const id = await deletion(instance);
      expect(await eraseInstance(db, id)).toBe(false);
    } else {
      await changeD1(db, async (writes) => {
        writes.push(
          db
            .update(instances)
            .set({ state: 'archived' })
            .where(eq(instances.id, instance.id)),
        );
      });
    }
    await expect(startMatch(runtime as Env, starting)).rejects.toThrow(
      'MATCH_START_DENIED',
    );
    expect(
      (await db.select().from(matches).where(eq(matches.matchId, starting.matchId)))[0]
        .status,
    ).toBe('waiting');
  },
);

it('開始済み試合の開始応答は非公開化後も再取得できる', async () => {
  const { instance, starting } = await waitingMatch();
  await startMatch(runtime as Env, starting);
  const id = await deletion(instance);
  await expect(startMatch(runtime as Env, starting)).resolves.toBeUndefined();
  await expect(eraseInstance(db, id)).rejects.toThrow('RESULT_OR_MATCH_PENDING');
});

it.each([false, true])(
  '削除受付後も消去直前に進行中の試合を再検査する 補助データ=%s',
  async (auxiliary) => {
    const { instance, starting } = await waitingMatch();
    const id = await deletion(instance);
    expect(await eraseInstance(db, id)).toBe(false);
    if (auxiliary) {
      const peerOrigin = `https://${crypto.randomUUID()}.test`;
      await changeD1(db, async (writes) => {
        writes.push(
          db.insert(federationPeers).values({
            origin: peerOrigin,
            name: '相手',
            kid: 'fixture',
            publicKey: '{}',
          }),
          db
            .insert(federationMetadataJobs)
            .values({ instanceId: instance.id, peerOrigin }),
        );
      });
    }
    // Reproduce a running row left by the previous start/deletion race.
    await changeD1(db, async (writes) => {
      writes.push(
        db
          .update(matches)
          .set({
            status: 'running',
            startedAt: new Date(starting.startedAt as number).toISOString(),
            payload: starting,
          })
          .where(eq(matches.matchId, starting.matchId)),
      );
    });
    await expect(eraseInstance(db, id)).rejects.toThrow('RESULT_OR_MATCH_PENDING');
    expect(
      await db.select().from(matches).where(eq(matches.matchId, starting.matchId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(instances).where(eq(instances.id, instance.id)),
    ).toHaveLength(1);
    if (auxiliary)
      expect(
        await db
          .select()
          .from(federationMetadataJobs)
          .where(eq(federationMetadataJobs.instanceId, instance.id)),
      ).toHaveLength(1);
  },
);

it.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])(
  '削除完了済みの試合と親ロビーを解放する 開始待ち=%s 親あり=%s',
  async (starting, hasParent) => {
    const { instance, starting: record } = await waitingMatch();
    const parent = hasParent ? await parentLobby(instance) : undefined;
    const operationId = await deletion(instance);
    expect(await eraseInstance(db, operationId)).toBe(false);
    expect(await eraseInstance(db, operationId)).toBe(true);
    const stub = runtime.GAME_ROOM.getByName(`match:${record.matchId}`);
    const { state } = resultFixture();
    state.matchId = record.matchId;
    state.phase = 'WAITING';
    state.result = null;
    state.deadline = null;
    delete state.completed;
    const { rules, ...definition } = record.definition;
    state.definition = definition;
    state.rules = rules;
    state.parentRoomId = parent ? parent.id : crypto.randomUUID();
    await runInDurableObject(stub, async (_, context) => {
      await context.storage.put('room', {
        scope: { id: instance.id, owner: instance.owner },
        state,
        sessions: {},
        generations: {},
        ...(starting ? { starting: record } : {}),
        lifecycleRetryAt: 1,
        lobby: {
          expires: Date.now() + 60000,
          sessionExpires: Date.now() + 60000,
          reservations: {},
          closed: !starting,
        },
      });
      await context.storage.setAlarm(Date.now() + 60000);
    });
    await evictDurableObject(stub);
    if (parent) await evictDurableObject(parent.stub);
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (_, context) => {
      expect((await context.storage.list()).size).toBe(0);
      expect(await context.storage.getAlarm()).toBeNull();
    });
    if (parent)
      await runInDurableObject(parent.stub, async (_, context) => {
        expect((await context.storage.list()).size).toBe(0);
        expect(await context.storage.getAlarm()).toBeNull();
      });
  },
);

it.each(['alarm', 'sync', 'cancel'])(
  '子試合のない親ロビーも削除後に保存状態と接続を解放する 経路=%s',
  async (route) => {
    const { instance } = await target();
    const parent = await parentLobby(instance);
    const token = crypto.randomUUID();
    expect(
      await parent.stub.joinUserRoom(
        parent.actor,
        token,
        crypto.randomUUID(),
        '',
        '',
        parent.scope,
      ),
    ).toMatchObject({ ok: true });
    const response = await parent.stub.fetch('https://room.test', {
      headers: {
        Upgrade: 'websocket',
        'X-Game-Session': token,
        'X-Game-Instance': instance.id,
      },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error(`upgrade:${response.status}`);
    socket.accept();
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener('close', resolve, { once: true });
    });
    try {
      const operationId = await deletion(instance);
      expect(await eraseInstance(db, operationId)).toBe(false);
      expect(await eraseInstance(db, operationId)).toBe(true);
      if (route === 'alarm') await runDurableObjectAlarm(parent.stub);
      else if (route === 'cancel')
        expect(
          await parent.stub.cancelReservation(
            'room',
            parent.actor.id,
            false,
            crypto.randomUUID(),
            token,
          ),
        ).toBe(true);
      else socket.send('sync');
      expect((await closed).reason).toBe('ROOM_CLOSED');
      await runInDurableObject(parent.stub, async (_, context) => {
        expect((await context.storage.list()).size).toBe(0);
        expect(await context.storage.getAlarm()).toBeNull();
      });
    } finally {
      socket.close();
    }
  },
);

it.each(['none', 'accepted', 'other', 'present'])(
  '親ロビーは一致する削除完了証跡と不存在を確認できなければ状態を保持する 証跡=%s',
  async (proof) => {
    const { instance } = await target();
    const parent = await parentLobby(instance);
    if (proof === 'accepted' || proof === 'present') {
      const id = await deletion(instance);
      expect(await eraseInstance(db, id)).toBe(false);
      if (proof === 'present')
        await changeD1(db, async (writes) => {
          writes.push(
            db
              .update(instanceDeletions)
              .set({
                deletedAt: new Date().toISOString(),
              })
              .where(eq(instanceDeletions.id, id)),
          );
        });
    } else if (proof === 'other') {
      const other = await target();
      const id = await deletion(other.instance);
      expect(await eraseInstance(db, id)).toBe(false);
      expect(await eraseInstance(db, id)).toBe(true);
    }
    await changeD1(db, async (writes) => {
      writes.push(db.delete(instanceRooms).where(eq(instanceRooms.roomId, parent.id)));
    });
    await evictDurableObject(parent.stub);
    await runInDurableObject(parent.stub, async (_, context) => {
      await expect(new RoomLobby(context, runtime).read()).rejects.toThrow(
        'ROOM_DATA_INCOMPLETE',
      );
      expect((await context.storage.list()).size).toBeGreaterThan(0);
      expect(await context.storage.getAlarm()).not.toBeNull();
    });
  },
);

it.each(['none', 'accepted', 'other'])(
  '一致する削除完了証跡がなければ行欠落を成功にしない 証跡=%s',
  async (proof) => {
    const { instance, starting } = await waitingMatch();
    if (proof === 'accepted') {
      const id = await deletion(instance);
      expect(await eraseInstance(db, id)).toBe(false);
    } else if (proof === 'other') {
      const other = await target();
      const id = await deletion(other.instance);
      expect(await eraseInstance(db, id)).toBe(false);
      expect(await eraseInstance(db, id)).toBe(true);
    }
    const missing = { ...starting, matchId: crypto.randomUUID() };
    await expect(startMatch(runtime, missing)).rejects.toThrow('MATCH_CLOSED');
    await expect(cancelMatch(runtime, instance.owner, missing.matchId)).rejects.toThrow(
      'MATCH_NOT_FOUND',
    );
    await expect(
      cancelMatch(runtime, 'https://wrong-owner.test', starting.matchId),
    ).rejects.toThrow('MATCH_OWNER_MISMATCH');
  },
);
