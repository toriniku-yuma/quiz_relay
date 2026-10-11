import { applyD1Migrations, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { disabledFederationPermissions } from '../src/shared/federation';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  federationMetadata,
  federationMetadataJobs,
  federationPeers,
  federationTargets,
  instances,
  organizations,
} from '../src/worker/db/schema';

it('組織参加への移行は既存のキャッシュ・同期ジョブ・鍵を保持し、組織IDの取得情報も保存できる', async () => {
  const runtime = env as unknown as {
    GAME_D1: D1Database;
    D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  };
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS.slice(0, -1));
  const db = connectD1(runtime.GAME_D1),
    organizationId = crypto.randomUUID(),
    instanceId = crypto.randomUUID();
  const origin = 'https://peer.quiz-relay.workers.dev';
  const payload = {
    snapshot: 'a'.repeat(64),
    sourceInstanceId: instanceId,
    organization: { id: crypto.randomUUID(), name: '相手' },
    instances: [
      {
        id: crypto.randomUUID(),
        name: '開催先',
        ranked: true,
        casual: true,
        permissions: disabledFederationPermissions(),
      },
    ],
    nextCursor: null,
  };
  await changeD1(db, async (writes) => {
    writes.push(
      rowsD1(organizations, [
        { id: organizationId, name: '移行確認', identityNamespace: 'migration-test' },
      ]),
      rowsD1(instances, [
        { id: instanceId, organizationId, owner: `urn:uuid:${instanceId}`, name: '既存' },
      ]),
      rowsD1(federationPeers, [
        {
          origin,
          name: '既存鍵',
          kid: 'existing',
          publicKey: 'preserved-key',
          approved: true,
        },
      ]),
      rowsD1(federationMetadata, [
        { instanceId, peerOrigin: origin, payload, lastSuccessAt: 1234 },
      ]),
      rowsD1(federationMetadataJobs, [
        { instanceId, peerOrigin: origin, nextAttemptAt: 2345, failures: 2 },
      ]),
      rowsD1(federationTargets, [
        {
          sourceInstanceId: instanceId,
          peerOrigin: origin,
          instanceId: payload.instances[0].id,
          payload,
          checkedAt: 3456,
        },
      ]),
    );
  });
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  expect((await db.select().from(organizations))[0]).toMatchObject({
    externalParticipation: 'approved',
    federationRevision: 1,
  });
  expect((await db.select().from(federationPeers))[0]).toMatchObject({
    approved: true,
    receiveRanked: true,
    receiveCasual: true,
    publicKey: 'preserved-key',
  });
  expect((await db.select().from(federationMetadata))[0]).toMatchObject({
    instanceId,
    payload,
    lastSuccessAt: 1234,
  });
  expect((await db.select().from(federationMetadataJobs))[0]).toMatchObject({
    instanceId,
    nextAttemptAt: 2345,
    failures: 2,
  });
  expect((await db.select().from(federationTargets))[0]).toMatchObject({
    sourceInstanceId: instanceId,
    payload,
    checkedAt: 3456,
  });
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(federationMetadata).values({
        instanceId: organizationId,
        peerOrigin: origin,
        payload: { ...payload, sourceInstanceId: organizationId },
        lastSuccessAt: 4567,
      }),
      db
        .insert(federationMetadataJobs)
        .values({ instanceId: organizationId, peerOrigin: origin }),
      db.insert(federationTargets).values({
        sourceInstanceId: organizationId,
        peerOrigin: origin,
        instanceId: payload.instances[0].id,
        payload: { ...payload, sourceInstanceId: organizationId },
        checkedAt: 4567,
      }),
    );
  });
  expect(await db.select().from(federationMetadata)).toHaveLength(2);
  expect(await db.select().from(federationMetadataJobs)).toHaveLength(2);
  expect(await db.select().from(federationTargets)).toHaveLength(2);
  expect(
    (await runtime.GAME_D1.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
});
