import { applyD1Migrations, env } from 'cloudflare:test';
import { and, eq, sql } from 'drizzle-orm';
import { exportSPKI, generateKeyPair } from 'jose';
import { beforeAll, expect, it } from 'vitest';
import type { FederationPeer } from '../src/shared/federation';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  federationFavorites,
  federationMetadata,
  federationPeerKeys,
  federationPeers,
  federationTargets,
  instances,
  organizations,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { requireParticipationReceiving } from '../src/worker/federation/admission';
import {
  externalInstanceDirectory,
  favoriteExternalInstance,
} from '../src/worker/federation/directory';
import {
  federationOverview,
  manageFederation,
} from '../src/worker/federation/management';
import { localMetadata } from '../src/worker/federation/metadata';
import { addInstance, setupOrganization } from '../src/worker/organization/database';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1);
const origin = 'https://peer.quiz-relay.workers.dev';
let publicKey: string;
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  publicKey = await exportSPKI(
    (await generateKeyPair('EdDSA', { extractable: true })).publicKey,
  );
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '連携検証',
    instanceName: '最初',
  });
});
const admission = {
  participationBlocked: false,
  receiveRanked: true,
  receiveCasual: true,
};
const peer = (revision = 0, approved = true, kid = 'first', key = publicKey) =>
  manageFederation(db, 'admin', {
    operation: 'peer',
    origin,
    name: '承認した相手',
    kid,
    publicKey: key,
    approved,
    ...admission,
    revision,
  });
const editPeer = (
  { discovered: _discovered, ...current }: FederationPeer,
  changes: Partial<FederationPeer>,
) => manageFederation(db, 'admin', { operation: 'peer', ...current, ...changes });
async function policy() {
  const instanceId = crypto.randomUUID(),
    peerInstanceId = crypto.randomUUID();
  await addInstance(db, 'admin', { id: instanceId, name: '対象' });
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(federationMetadata).values({
        instanceId,
        peerOrigin: origin,
        lastSuccessAt: Date.now(),
        payload: {
          snapshot: 'a'.repeat(64),
          sourceInstanceId: instanceId,
          organization: { id: crypto.randomUUID(), name: '相手' },
          instances: [
            {
              id: peerInstanceId,
              name: '連携先',
              ranked: true,
              casual: true,
            },
          ],
          nextCursor: null,
        },
      }),
    );
  });
  const value = await manageFederation(db, 'admin', {
    operation: 'policy',
    instanceId,
    peerOrigin: origin,
    peerInstanceId,
  });
  if (!('id' in value)) throw new Error('POLICY_REQUIRED');
  return { id: value.id, instanceId, peerInstanceId };
}
it('承認は管理者専用で、公開HTTPSの固定送信先とEd25519公開鍵だけを登録する', async () => {
  await expect(
    manageFederation(db, 'member', {
      operation: 'peer',
      origin,
      name: '相手',
      kid: 'first',
      publicKey,
      approved: true,
      ...admission,
      revision: 0,
    }),
  ).rejects.toThrow('ADMIN_REQUIRED');
  for (const url of [
    'http://peer.quiz-relay.workers.dev',
    'https://127.0.0.1',
    'https://peer.quiz-relay.workers.dev/path',
    'https://peer.quiz-relay.workers.dev:8443',
  ]) {
    await expect(
      manageFederation(db, 'admin', {
        operation: 'peer',
        origin: url,
        name: '相手',
        kid: 'first',
        publicKey,
        approved: true,
        ...admission,
        revision: 0,
      }),
    ).rejects.toThrow('INVALID_PEER_ORIGIN');
  }
  await peer();
  expect((await federationOverview(db, 'admin')).peers).toHaveLength(1);
  await expect(federationOverview(db, 'member')).rejects.toThrow('ADMIN_REQUIRED');
});
it('同じkidへの別鍵の上書きを拒否し、明示した新しいkidの鍵履歴を保持する', async () => {
  const replacement = await exportSPKI(
    (await generateKeyPair('EdDSA', { extractable: true })).publicKey,
  );
  await expect(peer(1, true, 'first', replacement)).rejects.toThrow('PEER_KEY_CONFLICT');
  await peer(1, true, 'second', replacement);
  expect(await db.select().from(federationPeerKeys)).toHaveLength(2);
  await expect(peer(1)).rejects.toThrow('FEDERATION_CONFLICT');
});
it('外部受入の初期値・管理者権限・競合を確認し、承認と禁止・対戦種別を独立して保存する', async () => {
  const initial = await federationOverview(db, 'admin');
  expect(initial.admission).toEqual({ mode: 'approved', revision: 1 });
  await expect(
    manageFederation(db, 'member', {
      operation: 'admission',
      mode: 'unblocked',
      revision: 1,
    }),
  ).rejects.toThrow('ADMIN_REQUIRED');
  await manageFederation(db, 'admin', {
    operation: 'admission',
    mode: 'unblocked',
    revision: 1,
  });
  await expect(
    manageFederation(db, 'admin', {
      operation: 'admission',
      mode: 'approved',
      revision: 1,
    }),
  ).rejects.toThrow('FEDERATION_CONFLICT');
  const current = (await federationOverview(db, 'admin')).peers[0];
  await editPeer(current, { approved: false, receiveRanked: false, receiveCasual: true });
  const [updated] = (await federationOverview(db, 'admin')).peers;
  expect(updated).toMatchObject({
    approved: false,
    participationBlocked: false,
    receiveRanked: false,
    receiveCasual: true,
  });
  await expect(requireParticipationReceiving(db, origin, 'ranked')).rejects.toThrow(
    'FEDERATION_PARTICIPATION_DENIED',
  );
  await expect(
    requireParticipationReceiving(db, origin, 'room'),
  ).resolves.toBeUndefined();
  await editPeer(updated, { approved: true, participationBlocked: true });
  await expect(requireParticipationReceiving(db, origin, 'room')).rejects.toThrow(
    'FEDERATION_PARTICIPATION_DENIED',
  );
  const [blocked] = (await federationOverview(db, 'admin')).peers;
  await editPeer(blocked, { participationBlocked: false, receiveRanked: true });
  await manageFederation(db, 'admin', {
    operation: 'admission',
    mode: 'approved',
    revision: 2,
  });
});
it('インスタンスごとの問題共有は初期状態ですべてオフ。同じ組合せの追加は重複しない', async () => {
  const target = await policy();
  const replay = await manageFederation(db, 'admin', {
    operation: 'policy',
    instanceId: target.instanceId,
    peerOrigin: origin,
    peerInstanceId: target.peerInstanceId,
  });
  expect(replay).toMatchObject({ id: target.id });
  expect(
    (await federationOverview(db, 'admin')).policies.find((row) => row.id === target.id),
  ).toMatchObject({ sendQuestions: false, receiveQuestions: false });
});
it('一括変更は選択した既存対象だけを変更し、プレビューでは保存しない。競合は対象ごとに返す', async () => {
  const first = await policy(),
    second = await policy(),
    untouched = await policy();
  const sharing = { sendQuestions: true, receiveQuestions: false };
  const items = [
    { id: first.id, revision: 1, ...sharing },
    { id: second.id, revision: 0, ...sharing },
    { id: crypto.randomUUID(), revision: 1, ...sharing },
  ];
  const preview = await manageFederation(db, 'admin', {
    operation: 'previewPolicies',
    items,
  });
  expect(preview).toMatchObject({
    results: [
      {
        id: first.id,
        ok: true,
        before: { sendQuestions: false, receiveQuestions: false },
        after: sharing,
      },
      { id: second.id, ok: false, code: 'FEDERATION_CONFLICT' },
      { ok: false, code: 'FEDERATION_TARGET_UNAVAILABLE' },
    ],
  });
  expect(
    (await federationOverview(db, 'admin')).policies.find((row) => row.id === first.id)
      ?.revision,
  ).toBe(1);
  await manageFederation(db, 'admin', { operation: 'policies', items });
  const current = (await federationOverview(db, 'admin')).policies;
  expect(current.find((row) => row.id === first.id)).toMatchObject(sharing);
  expect(current.find((row) => row.id === second.id)).toMatchObject({
    sendQuestions: false,
    receiveQuestions: false,
  });
  expect(current.find((row) => row.id === untouched.id)?.revision).toBe(1);
});

it('外部のお気に入りは本人ごとに保存し、明示禁止・取得失敗でも登録を残して解除できる', async () => {
  const target = await policy();
  const [cache] = await db
    .select()
    .from(federationMetadata)
    .where(
      and(
        eq(federationMetadata.instanceId, target.instanceId),
        eq(federationMetadata.peerOrigin, origin),
      ),
    );
  cache.payload.instances[0].ranked = false;
  const [organization] = await db.select().from(organizations);
  await changeD1(db, async (writes) => {
    writes.push(
      rowsD1(
        federationMetadata,
        [
          {
            ...cache,
            instanceId: organization.id,
            payload: { ...cache.payload, sourceInstanceId: organization.id },
            lastSuccessAt: Date.now(),
          },
        ],
        true,
      ),
    );
  });
  const input = {
    operation: 'favorite',
    peerOrigin: origin,
    instanceId: target.peerInstanceId,
    added: true,
  };
  await favoriteExternalInstance(db, 'admin', input);
  await favoriteExternalInstance(db, 'admin', input);
  expect(await db.select().from(federationFavorites)).toHaveLength(1);
  expect(
    (await externalInstanceDirectory(db, 'admin')).instances.find(
      (row) => row.instanceId === target.peerInstanceId,
    ),
  ).toMatchObject({ favorite: true, available: true, ranked: false, casual: true });
  expect(
    (await externalInstanceDirectory(db, 'member')).instances.some((row) => row.favorite),
  ).toBe(false);
  const [registered] = (await federationOverview(db, 'admin')).peers;
  await editPeer(registered, { approved: false, participationBlocked: true });
  expect(
    (await externalInstanceDirectory(db, 'admin')).instances.find(
      (row) => row.instanceId === target.peerInstanceId,
    ),
  ).toMatchObject({ favorite: true, available: false });
  await editPeer(registered, { approved: true, revision: registered.revision + 1 });
  expect(
    (await externalInstanceDirectory(db, 'admin')).instances.find(
      (row) => row.instanceId === target.peerInstanceId,
    )?.available,
  ).toBe(true);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(federationMetadata)
        .set({ errorCode: 'FEDERATION_PEER_UNAVAILABLE' })
        .where(eq(federationMetadata.instanceId, organization.id)),
    );
  });
  expect(
    (await externalInstanceDirectory(db, 'admin')).instances.find(
      (row) => row.instanceId === target.peerInstanceId,
    ),
  ).toMatchObject({ favorite: true, available: false });
  await expect(favoriteExternalInstance(db, 'admin', input)).rejects.toThrow(
    'FEDERATION_TARGET_UNAVAILABLE',
  );
  await favoriteExternalInstance(db, 'admin', { ...input, added: false });
  expect(await db.select().from(federationFavorites)).toHaveLength(0);
});

it('組織単位のURL取得と定期取得は、新しい方の取得結果で参加先を判断する', async () => {
  const target = await policy();
  const [organization] = await db.select().from(organizations);
  const time = Date.now(),
    key = and(
      eq(federationMetadata.instanceId, organization.id),
      eq(federationMetadata.peerOrigin, origin),
    );
  const [cached] = await db
    .select()
    .from(federationMetadata)
    .where(eq(federationMetadata.instanceId, target.instanceId));
  const allowed = structuredClone(cached.payload);
  allowed.sourceInstanceId = organization.id;
  allowed.instances[0].casual = false;
  const denied = structuredClone(allowed);
  denied.instances[0].ranked = false;
  const read = async () =>
    (
      await externalInstanceDirectory(db, 'admin', false, {
        peerOrigin: origin,
        instanceId: target.peerInstanceId,
      })
    ).instances.find((row) => row.instanceId === target.peerInstanceId);
  const saveTarget = (payload: typeof allowed, checkedAt: number) =>
    changeD1(db, async (writes) => {
      writes.push(
        rowsD1(
          federationTargets,
          [
            {
              sourceOrganizationId: organization.id,
              peerOrigin: origin,
              instanceId: target.peerInstanceId,
              payload,
              checkedAt,
            },
          ],
          true,
        ),
      );
    });
  await changeD1(db, async (writes) => {
    writes.push(
      rowsD1(
        federationMetadata,
        [
          {
            instanceId: organization.id,
            peerOrigin: origin,
            payload: allowed,
            lastSuccessAt: time - 30000,
            nextCursor: null,
            errorCode: null,
          },
        ],
        true,
      ),
    );
  });
  await saveTarget(denied, time - 20000);
  expect(await read()).toBeUndefined();
  await saveTarget(allowed, time - 10000);
  expect(await read()).toMatchObject({ available: true, ranked: true });
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(federationMetadata)
        .set({ payload: denied, lastSuccessAt: time - 5000 })
        .where(key),
    );
  });
  expect(await read()).toBeUndefined();
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(federationMetadata)
        .set({ payload: { ...allowed, instances: [] }, lastSuccessAt: time - 4000 })
        .where(key),
    );
  });
  expect(await read()).toBeUndefined();

  // Only absence within the retrieved page is authoritative during pagination.
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(federationMetadata)
        .set({
          payload: {
            ...allowed,
            instances: [],
            nextCursor: '00000000-0000-4000-8000-000000000000',
          },
          nextCursor: '00000000-0000-4000-8000-000000000000',
          lastSuccessAt: time - 3000,
        })
        .where(key),
    );
  });
  expect(await read()).toMatchObject({ available: true, ranked: true });
  await saveTarget(denied, time);
  const otherSource = crypto.randomUUID();
  await addInstance(db, 'admin', { id: otherSource, name: '別の参加元' });
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(federationMetadata).values({
        instanceId: otherSource,
        peerOrigin: origin,
        payload: { ...allowed, sourceInstanceId: otherSource },
        lastSuccessAt: time,
      }),
    );
  });
  expect(await read()).toBeUndefined();
});

it('101件以上の一覧を固定版で分割し、途中の公開情報変更を拒否する', async () => {
  const [template] = await db.select().from(instances);
  const created = Array.from({ length: 101 }, (_, index) => {
    const id = crypto.randomUUID();
    return {
      ...template,
      id,
      owner: `urn:uuid:${id}`,
      name: `一覧検証${index}`,
      state: 'published' as const,
    };
  });
  await changeD1(db, async (writes) => {
    writes.push(
      rowsD1(instances, created),
      db
        .update(federationPeers)
        .set({ approved: true })
        .where(eq(federationPeers.origin, origin)),
    );
  });
  const sourceInstanceId = crypto.randomUUID(),
    first = await localMetadata(db, origin, { sourceInstanceId });
  expect(first.instances).toHaveLength(100);
  const request = {
    sourceInstanceId,
    cursor: first.nextCursor,
    snapshot: first.snapshot,
  };
  const second = await localMetadata(db, origin, request);
  expect(second.instances.length).toBeGreaterThan(0);
  expect(second.snapshot).toBe(first.snapshot);
  expect(
    new Set([...first.instances, ...second.instances].map((row) => row.id)).size,
  ).toBe(first.instances.length + second.instances.length);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ name: '公開名の変更' })
        .where(eq(instances.id, created[0].id)),
    );
  });
  await expect(localMetadata(db, origin, request)).rejects.toThrow(
    'FEDERATION_SNAPSHOT_CHANGED',
  );
});

it('連続する設定更新中も公開名と参加許可を同じ版から返す', async () => {
  const [instance] = await db.select().from(instances);
  const sourceInstanceId = crypto.randomUUID();
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ state: 'published', name: '版0', rankedPauseReason: null })
        .where(eq(instances.id, instance.id)),
      db
        .update(federationPeers)
        .set({ approved: true, participationBlocked: false, receiveRanked: true })
        .where(eq(federationPeers.origin, origin)),
    );
  });
  const update = async () => {
    for (let version = 1; version <= 12; version++) {
      await changeD1(db, async (writes) => {
        writes.push(
          db
            .update(instances)
            .set({ name: `版${version}` })
            .where(eq(instances.id, instance.id)),
          db
            .update(federationPeers)
            .set({
              revision: sql`${federationPeers.revision}+1`,
              receiveRanked: version % 2 === 0,
            })
            .where(eq(federationPeers.origin, origin)),
        );
      });
    }
  };
  const read = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const page = await localMetadata(db, origin, {
        sourceInstanceId,
        targetInstanceId: instance.id,
      });
      expect(page.instances).toHaveLength(1);
      const returned = page.instances[0],
        version = Number(returned.name.slice(1));
      expect(returned.ranked).toBe(version % 2 === 0);
    }
  };
  await Promise.all([update(), read()]);
});
