import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { beforeAll, expect, it, vi } from 'vitest';
import { changeD1, connectD1, readD1 } from '../src/worker/db/d1';
import {
  federationMetadata,
  federationMetadataJobs,
  instances,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { manageFederation } from '../src/worker/federation/management';
import { METADATA_PATH, syncPeerMetadata } from '../src/worker/federation/metadata';
import {
  boundedText,
  consumeNonce,
  expireFederationNonces,
  receiveDelivery,
  signedDelivery,
} from '../src/worker/federation/transport';
import app from '../src/worker/index';
import { setupOrganization } from '../src/worker/organization/database';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  PEER_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const db = connectD1(runtime.GAME_D1),
  peerDb = connectD1(runtime.PEER_D1);
it('nonceの同時消費は一度だけ成功し、業務データの読取世代を変更しない', async () => {
  const nonce = crypto.randomUUID();
  let reads = 0;
  const accepted = await readD1(db, async () => {
    reads++;
    return Promise.all(
      Array.from({ length: 10 }, () =>
        consumeNonce(
          db,
          sourceOrigin,
          'concurrency-test',
          nonce,
          Math.floor(Date.now() / 1000) + 120,
        ),
      ),
    );
  });
  expect(accepted.filter(Boolean)).toHaveLength(1);
  expect(reads).toBe(1);
  await readD1(db, async () => {
    await expireFederationNonces(db);
  });
  expect(await consumeNonce(db, sourceOrigin, 'concurrency-test', nonce, 0)).toBe(false);
});
let source: Env, host: Env, instanceId: string;
const sourceOrigin = 'https://source.quiz-relay.workers.dev',
  hostOrigin = 'https://host.quiz-relay.workers.dev';
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await applyD1Migrations(runtime.PEER_D1, runtime.D1_MIGRATIONS);
  const sourceKeys = await generateKeyPair('EdDSA', { extractable: true }),
    hostKeys = await generateKeyPair('EdDSA', { extractable: true });
  source = {
    ...env,
    GAME_D1: runtime.GAME_D1,
    FEDERATION_ORIGIN: sourceOrigin,
    SIGNING_KID: 'source',
    SIGNING_PRIVATE_KEY: await exportPKCS8(sourceKeys.privateKey),
  } as Env;
  host = {
    ...env,
    GAME_D1: runtime.PEER_D1,
    FEDERATION_ORIGIN: hostOrigin,
    SIGNING_KID: 'host',
    SIGNING_PRIVATE_KEY: await exportPKCS8(hostKeys.privateKey),
  } as Env;
  await setupOrganization(
    db,
    { INITIAL_ADMIN_SUBJECT: 'source-admin' } as Env,
    'source-admin',
    { name: '所属元', instanceName: '所属元インスタンス' },
  );
  await setupOrganization(
    peerDb,
    { INITIAL_ADMIN_SUBJECT: 'host-admin' } as Env,
    'host-admin',
    { name: '開催元', instanceName: '公開インスタンス' },
  );
  instanceId = (await db.select().from(instances))[0].id;
  await changeD1(peerDb, async (writes) => {
    writes.push(peerDb.update(instances).set({ state: 'published' }));
  });
  await manageFederation(db, 'source-admin', {
    operation: 'peer',
    origin: hostOrigin,
    name: '開催元',
    kid: 'host',
    publicKey: await exportSPKI(hostKeys.publicKey),
    approved: true,
    participationBlocked: false,
    receiveRanked: true,
    receiveCasual: true,
    revision: 0,
  });
  await manageFederation(peerDb, 'host-admin', {
    operation: 'peer',
    origin: sourceOrigin,
    name: '所属元',
    kid: 'source',
    publicKey: await exportSPKI(sourceKeys.publicKey),
    approved: true,
    participationBlocked: false,
    receiveRanked: true,
    receiveCasual: true,
    revision: 0,
  });
});
it('別D1・別署名鍵の通常Worker同士で署名要求・応答とインスタンス情報の保存を確認する', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => app.request(input as Request, undefined, host));
  try {
    expect(
      await syncPeerMetadata(source, 'source-admin', {
        operation: 'syncMetadata',
        instanceId,
        peerOrigin: hostOrigin,
      }),
    ).toEqual({ ok: true, nextCursor: null });
    const [metadata] = await db.select().from(federationMetadata);
    expect(metadata.payload.organization.name).toBe('開催元');
    expect(metadata.payload.instances).toHaveLength(1);
    expect(JSON.stringify(metadata.payload)).not.toContain('publicKey');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});
it('分の境界をまたぐ同期でも次の毎分実行で再取得できる', async () => {
  const started = Math.floor(Date.now() / 60000) * 60000 + 59000;
  let now = started;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    now += 2000;
    return app.request(input as Request, undefined, host);
  });
  try {
    await syncPeerMetadata(source, 'source-admin', {
      operation: 'syncMetadata',
      instanceId,
      peerOrigin: hostOrigin,
    });
    const [job] = await db
      .select()
      .from(federationMetadataJobs)
      .where(eq(federationMetadataJobs.instanceId, instanceId));
    expect(job.errorCode).toBeNull();
    expect(job.nextAttemptAt).toBeLessThanOrEqual(started + 60000);
  } finally {
    fetch.mockRestore();
    clock.mockRestore();
  }
});
it('署名済み要求の再送・用途や受取先が違う応答を拒否する', async () => {
  const message = await signedDelivery(
    source,
    hostOrigin,
    METADATA_PATH,
    'metadata.request',
    { sourceInstanceId: instanceId },
  );
  const request = () =>
    new Request(hostOrigin + METADATA_PATH, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  expect((await receiveDelivery(request(), host, 'metadata.request')).issuer).toBe(
    sourceOrigin,
  );
  await expect(receiveDelivery(request(), host, 'metadata.request')).rejects.toThrow(
    'FEDERATION_REPLAY',
  );
  const wrong = await signedDelivery(
    source,
    hostOrigin,
    METADATA_PATH,
    'metadata.response',
    {},
  );
  await expect(
    receiveDelivery(
      new Request(hostOrigin + METADATA_PATH, {
        method: 'POST',
        body: JSON.stringify({ message: wrong }),
      }),
      host,
      'metadata.request',
    ),
  ).rejects.toThrow('FEDERATION_SIGNATURE_REJECTED');
  const misdirected = await signedDelivery(
    source,
    sourceOrigin,
    METADATA_PATH,
    'metadata.request',
    {},
  );
  await expect(
    receiveDelivery(
      new Request(hostOrigin + METADATA_PATH, {
        method: 'POST',
        body: JSON.stringify({ message: misdirected }),
      }),
      host,
      'metadata.request',
    ),
  ).rejects.toThrow('FEDERATION_SIGNATURE_REJECTED');
});
it('停止・転送・応答不明では取得成功扱いにせず、保存済み情報を利用不可にする', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { Location: 'https://other.quiz-relay.workers.dev' },
    }),
  );
  try {
    await expect(
      syncPeerMetadata(source, 'source-admin', {
        operation: 'syncMetadata',
        instanceId,
        peerOrigin: hostOrigin,
      }),
    ).rejects.toThrow('FEDERATION_PEER_UNAVAILABLE');
    expect(
      (
        await db
          .select()
          .from(federationMetadata)
          .where(eq(federationMetadata.instanceId, instanceId))
      )[0].errorCode,
    ).toBe('FEDERATION_PEER_UNAVAILABLE');
  } finally {
    fetch.mockRestore();
  }
});
it('Content-LengthがなくてもHTTP本文の読込みを上限で中止する', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(32));
      controller.enqueue(new Uint8Array(32));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(boundedText(new Response(body), 40)).rejects.toThrow(
    'FEDERATION_MESSAGE_SIZE',
  );
  expect(cancelled).toBe(true);
});
it('偽署名では承認済み相手の通信枠を消費せず、署名検証後の超過を拒否する', async () => {
  const limiter = vi.fn(async () => ({ success: false }));
  const limited = { ...host, FEDERATION_LIMITER: { limit: limiter } } as Env;
  const message = await signedDelivery(
    source,
    hostOrigin,
    METADATA_PATH,
    'metadata.request',
    {},
  );
  const parts = message.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  const request = (signed: string) =>
    new Request(hostOrigin + METADATA_PATH, {
      method: 'POST',
      body: JSON.stringify({ message: signed }),
    });
  await expect(
    receiveDelivery(request(parts.join('.')), limited, 'metadata.request'),
  ).rejects.toThrow('FEDERATION_SIGNATURE_REJECTED');
  expect(limiter).not.toHaveBeenCalled();
  await expect(
    receiveDelivery(request(message), limited, 'metadata.request'),
  ).rejects.toThrow('RATE_LIMIT');
  expect(limiter).toHaveBeenCalledOnce();
  expect((await receiveDelivery(request(message), host, 'metadata.request')).issuer).toBe(
    sourceOrigin,
  );
});
it('取得失敗を永続化し、429の指定時刻を守り、復旧した署名応答だけで利用可能へ戻す', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': '180' } }),
    );
  const started = Date.now();
  try {
    await expect(
      syncPeerMetadata(source, 'source-admin', {
        operation: 'syncMetadata',
        instanceId,
        peerOrigin: hostOrigin,
      }),
    ).rejects.toThrow('FEDERATION_PEER_RATE_LIMIT');
    const [job] = await db
      .select()
      .from(federationMetadataJobs)
      .where(eq(federationMetadataJobs.instanceId, instanceId));
    expect(job.nextAttemptAt).toBeGreaterThanOrEqual(started + 180000);
    expect(job.errorCode).toBe('FEDERATION_PEER_RATE_LIMIT');
    expect(job.leaseUntil).toBe(0);
    fetch.mockImplementation(async (input) =>
      app.request(input as Request, undefined, host),
    );
    await syncPeerMetadata(source, 'source-admin', {
      operation: 'syncMetadata',
      instanceId,
      peerOrigin: hostOrigin,
    });
    const [recovered] = await db
      .select()
      .from(federationMetadataJobs)
      .where(eq(federationMetadataJobs.instanceId, instanceId));
    expect(recovered.failures).toBe(0);
    expect(recovered.errorCode).toBeNull();
    expect(
      (
        await db
          .select()
          .from(federationMetadata)
          .where(eq(federationMetadata.instanceId, instanceId))
      )[0].errorCode,
    ).toBeNull();
  } finally {
    fetch.mockRestore();
  }
});
