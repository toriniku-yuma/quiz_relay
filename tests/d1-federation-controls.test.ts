import { applyD1Migrations, env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { API_PATHS } from '../src/shared/api-paths';
import type { FederationControl } from '../src/shared/federation-controls';
import { contentHash } from '../src/worker/catalog/hash';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import {
  federationActors,
  federationControlDeliveries,
  federationControlInbox,
  federationDeletedInstances,
  federationPeers,
  federationReservations,
  federationRetiredIdentities,
  instances,
  organizationAccounts,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import {
  applyControlEvent,
  deliverControlEvent,
  planControlEvent,
  receiveControlEvent,
} from '../src/worker/federation/controls';
import { signEvent } from '../src/worker/federation/events';
import {
  federationOverview,
  manageFederation,
} from '../src/worker/federation/management';
import { signedDelivery } from '../src/worker/federation/transport';
import app from '../src/worker/index';
import {
  organizationIdentity,
  setupOrganization,
} from '../src/worker/organization/database';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  PEER_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const sourceDb = connectD1(runtime.GAME_D1),
  hostDb = connectD1(runtime.PEER_D1);
const sourceOrigin = 'https://source.quiz-relay.workers.dev',
  hostOrigin = 'https://host.quiz-relay.workers.dev';
const logout = vi.fn().mockResolvedValue(undefined),
  anonymize = vi.fn().mockResolvedValue(undefined);
let source: Env, host: Env;
const unlimited: RateLimit = { limit: async () => ({ success: true }) };
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await applyD1Migrations(runtime.PEER_D1, runtime.D1_MIGRATIONS);
  const sourceKeys = await generateKeyPair('EdDSA', { extractable: true }),
    hostKeys = await generateKeyPair('EdDSA', { extractable: true });
  source = {
    ...env,
    FEDERATION_LIMITER: unlimited,
    GAME_D1: runtime.GAME_D1,
    FEDERATION_ORIGIN: sourceOrigin,
    SIGNING_KID: 'source',
    SIGNING_PRIVATE_KEY: await exportPKCS8(sourceKeys.privateKey),
  } as Env;
  host = {
    ...env,
    FEDERATION_LIMITER: unlimited,
    GAME_D1: runtime.PEER_D1,
    ACCOUNT_ERASURE: {
      fetch: vi.fn(async () => Response.json({ ready: false }, { status: 503 })),
    },
    FEDERATION_ORIGIN: hostOrigin,
    SIGNING_KID: 'host',
    SIGNING_PRIVATE_KEY: await exportPKCS8(hostKeys.privateKey),
    MATCHMAKER: {
      getByName: () => ({ logoutActor: logout, anonymizeAccount: anonymize }),
    },
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
  await changeD1(sourceDb, async (writes) => {
    writes.push(
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
afterEach(() => vi.restoreAllMocks());

it('通信断と受信後の反映待ちを区別し、同じ署名原本を再送して匿名化を完了する', async () => {
  const sourceActorId = await contentHash(crypto.randomUUID());
  const { account } = await organizationIdentity(
    hostDb,
    `federation:${sourceOrigin}:${sourceActorId}`,
  );
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb.insert(federationActors).values({
        actorId: account.actorId,
        peerOrigin: sourceOrigin,
        sourceActorId,
        displayName: '過去の表示名',
      }),
    );
  });
  const payload: FederationControl = {
    version: 1,
    eventId: crypto.randomUUID(),
    type: 'withdrawal',
    subjectId: sourceActorId,
    createdAt: Date.now(),
  };
  await changeD1(sourceDb, async (writes) => planControlEvent(sourceDb, writes, payload));
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  await deliverControlEvent(source, hostOrigin, payload.eventId);
  const job = async () =>
    (
      await sourceDb
        .select()
        .from(federationControlDeliveries)
        .where(eq(federationControlDeliveries.eventId, payload.eventId))
    )[0];
  const failed = await job();
  expect(failed.receivedAt).toBeNull();
  expect(failed.quarantined).toBe(false);
  expect(failed.nextAttemptAt).toBeGreaterThan(Date.now());
  await expect(
    manageFederation(sourceDb, 'member', {
      operation: 'retryControl',
      peerOrigin: hostOrigin,
      eventId: payload.eventId,
    }),
  ).rejects.toThrow('ADMIN_REQUIRED');
  fetch.mockImplementation(async (input) =>
    app.request(input as Request, undefined, host),
  );
  await manageFederation(sourceDb, 'source-admin', {
    operation: 'retryControl',
    peerOrigin: hostOrigin,
    eventId: payload.eventId,
  });
  await deliverControlEvent(source, hostOrigin, payload.eventId);
  const received = await job();
  expect(received.message).toBe(failed.message);
  expect(received.receivedAt).not.toBeNull();
  expect(received.appliedAt).toBeNull();
  if (!host.ACCOUNT_ERASURE) throw new Error('TEST_SERVICE_REQUIRED');
  expect(
    vi
      .mocked(host.ACCOUNT_ERASURE.fetch)
      .mock.calls.some(
        ([, init]) => JSON.parse(String(init?.body)).task === 'federationControls',
      ),
  ).toBe(true);
  expect(
    (
      await hostDb
        .select()
        .from(organizationAccounts)
        .where(eq(organizationAccounts.actorId, account.actorId))
    )[0].withdrawnAt,
  ).not.toBeNull();
  expect(
    (
      await hostDb
        .select()
        .from(federationActors)
        .where(eq(federationActors.actorId, account.actorId))
    )[0].displayName,
  ).toBeNull();
  await applyControlEvent(host, sourceOrigin, payload.eventId);
  const inbox = async () =>
    (
      await hostDb
        .select()
        .from(federationControlInbox)
        .where(eq(federationControlInbox.eventId, payload.eventId))
    )[0];
  expect((await inbox()).appliedAt).not.toBeNull();
  await applyControlEvent(host, sourceOrigin, payload.eventId);
  expect(logout).not.toHaveBeenCalled();
  expect(anonymize).not.toHaveBeenCalled();
  await manageFederation(sourceDb, 'source-admin', {
    operation: 'retryControl',
    peerOrigin: hostOrigin,
    eventId: payload.eventId,
  });
  await deliverControlEvent(source, hostOrigin, payload.eventId);
  expect((await job()).appliedAt).not.toBeNull();
  expect((await job()).message).toBe(failed.message);
  expect(
    JSON.stringify((await federationOverview(sourceDb, 'source-admin')).controls),
  ).not.toContain('subjectId');
});
it('未知の退会者と削除先も永久に記録し、再送・改変・別署名元・原本削除を検査する', async () => {
  const payload: FederationControl = {
    version: 1,
    eventId: crypto.randomUUID(),
    type: 'withdrawal',
    subjectId: await contentHash(crypto.randomUUID()),
    createdAt: Date.now(),
  };
  const message = await signEvent(source, payload);
  expect(await receiveControlEvent(host, sourceOrigin, message)).toMatchObject({
    received: true,
    applied: true,
    duplicate: false,
  });
  expect(await receiveControlEvent(host, sourceOrigin, message)).toMatchObject({
    duplicate: true,
  });
  await expect(receiveControlEvent(host, hostOrigin, message)).rejects.toThrow(
    'FEDERATION_EVENT_REJECTED',
  );
  await expect(
    receiveControlEvent(
      host,
      sourceOrigin,
      await signEvent(source, { ...payload, subjectId: 'f'.repeat(64) }),
    ),
  ).rejects.toThrow('FEDERATION_EVENT_CONFLICT');
  const [original] = await hostDb
    .select()
    .from(federationControlInbox)
    .where(eq(federationControlInbox.eventId, payload.eventId));
  expect(original.payload).toEqual(payload);
  expect(original.conflictHash).not.toBeNull();
  const tombstone = and(
    eq(federationRetiredIdentities.peerOrigin, sourceOrigin),
    eq(federationRetiredIdentities.actorId, payload.subjectId),
  );
  expect(
    await hostDb.select().from(federationRetiredIdentities).where(tombstone),
  ).toHaveLength(1);
  await expect(
    hostDb.delete(federationRetiredIdentities).where(tombstone),
  ).rejects.toThrow();
  await expect(
    hostDb
      .delete(federationControlInbox)
      .where(eq(federationControlInbox.eventId, payload.eventId)),
  ).rejects.toThrow();
  const deleted: FederationControl = {
    ...payload,
    eventId: crypto.randomUUID(),
    type: 'instance-deleted',
    subjectId: crypto.randomUUID(),
  };
  expect(
    await receiveControlEvent(host, sourceOrigin, await signEvent(source, deleted)),
  ).toMatchObject({ applied: true });
  expect(
    (
      await hostDb
        .select()
        .from(federationDeletedInstances)
        .where(eq(federationDeletedInstances.instanceId, deleted.subjectId))
    )[0].peerOrigin,
  ).toBe(sourceOrigin);
});

it('承認を解除しても参加済みの退会通知は届き、無関係な退会者とインスタンス通知は拒否する', async () => {
  const sourceActorId = await contentHash(crypto.randomUUID());
  const { account } = await organizationIdentity(
    hostDb,
    `federation:${sourceOrigin}:${sourceActorId}`,
  );
  const [hostInstance] = await hostDb.select().from(instances).limit(1);
  const sourceOrganizationId = crypto.randomUUID();
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb.insert(federationActors).values({
        actorId: account.actorId,
        peerOrigin: sourceOrigin,
        sourceActorId,
        displayName: '参加済みの利用者',
      }),
      hostDb.insert(federationReservations).values({
        id: crypto.randomUUID(),
        peerOrigin: sourceOrigin,
        operationId: crypto.randomUUID(),
        requestHash: 'known',
        sourceOrganizationId,
        sourceActorId,
        actorId: account.actorId,
        instanceId: hostInstance.id,
        mode: 'ranked',
        displayName: '参加済みの利用者',
        state: 'closed',
        expiresAt: Date.now(),
      }),
      hostDb
        .update(federationPeers)
        .set({ approved: false })
        .where(eq(federationPeers.origin, sourceOrigin)),
    );
  });
  const receive = async (payload: FederationControl) =>
    app.request(
      hostOrigin + API_PATHS.federationInbox,
      {
        method: 'POST',
        body: JSON.stringify({
          message: await signedDelivery(
            source,
            hostOrigin,
            API_PATHS.federationInbox,
            'event',
            { event: await signEvent(source, payload) },
          ),
        }),
      },
      host,
    );
  const payload: FederationControl = {
    version: 1,
    eventId: crypto.randomUUID(),
    type: 'withdrawal',
    subjectId: sourceActorId,
    createdAt: Date.now(),
  };
  try {
    const unrelated = await receive({
      ...payload,
      eventId: crypto.randomUUID(),
      subjectId: 'e'.repeat(64),
    });
    expect(unrelated.status).toBe(403);
    expect(await unrelated.json()).toMatchObject({ code: 'FEDERATION_CONTROL_DENIED' });
    const wrongInstance = await receive({
      ...payload,
      eventId: crypto.randomUUID(),
      type: 'instance-deleted',
      subjectId: crypto.randomUUID(),
    });
    expect(wrongInstance.status).toBe(403);
    expect(await wrongInstance.json()).toMatchObject({
      code: 'FEDERATION_CONTROL_DENIED',
    });
    expect((await receive(payload)).status).toBe(202);
    expect(
      (
        await hostDb
          .select()
          .from(organizationAccounts)
          .where(eq(organizationAccounts.actorId, account.actorId))
      )[0].withdrawnAt,
    ).not.toBeNull();
  } finally {
    await changeD1(hostDb, async (writes) => {
      writes.push(
        hostDb
          .update(federationPeers)
          .set({ approved: true })
          .where(eq(federationPeers.origin, sourceOrigin)),
      );
    });
  }
});
