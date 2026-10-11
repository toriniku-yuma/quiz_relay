import { applyD1Migrations, env } from 'cloudflare:test';
import { count, inArray } from 'drizzle-orm';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import app, { type FederationTestEnv } from '../scripts/federation-worker';
import { connectD1 } from '../src/worker/db/d1';
import { instances, organizations, probeRuns } from '../src/worker/db/schema';
import { bodyHash, INBOX_PATH, signDelivery } from '../src/worker/federation/signatures';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  PEER_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origins = ['https://test-a.quiz.workers.dev', 'https://test-b.quiz.workers.dev'];
let a: FederationTestEnv, b: FederationTestEnv;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await applyD1Migrations(runtime.PEER_D1, runtime.D1_MIGRATIONS);
  signing = await generateKeyPair('EdDSA', { extractable: true });
  const peerSigning = await generateKeyPair('EdDSA', { extractable: true });
  a = {
    ...env,
    API_LIMITER: undefined,
    GAME_D1: runtime.GAME_D1,
    TEST_NODE: 'A',
    GAME_OWNER: origins[0],
    PEER_ORIGIN: origins[1],
    PROBES_ENABLED: 'true',
    PROBE_TOKEN: 'a'.repeat(48),
    SIGNING_KID: 'a-test',
    SIGNING_PRIVATE_KEY: await exportPKCS8(signing.privateKey),
    PEER_KID: 'b-test',
    PEER_PUBLIC_KEY: await exportSPKI(peerSigning.publicKey),
  } as FederationTestEnv;
  b = {
    ...a,
    TEST_NODE: 'B',
    GAME_D1: runtime.PEER_D1,
    GAME_OWNER: origins[1],
    PEER_ORIGIN: origins[0],
    PROBE_TOKEN: 'b'.repeat(48),
    SIGNING_KID: 'b-test',
    SIGNING_PRIVATE_KEY: await exportPKCS8(peerSigning.privateKey),
    PEER_KID: 'a-test',
    PEER_PUBLIC_KEY: await exportSPKI(signing.publicKey),
  };
});
beforeEach(async () => {
  for (const binding of [a.GAME_D1, b.GAME_D1])
    await connectD1(binding).delete(probeRuns);
  vi.stubGlobal('fetch', async (request: Request, options?: RequestInit) => {
    expect(request.url).toBe(origins[1] + INBOX_PATH);
    expect(request.redirect).toBe('manual');
    expect(request.headers.has('Authorization')).toBe(false);
    expect(request.headers.has('Cookie')).toBe(false);
    return app.fetch(new Request(request, options), b);
  });
});
afterEach(() => vi.unstubAllGlobals());

function probe(configuration: FederationTestEnv, path: string, body?: object) {
  return app.request(
    configuration.GAME_OWNER + path,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${configuration.PROBE_TOKEN}` },
      body: body ? JSON.stringify(body) : undefined,
    },
    configuration,
  );
}
it('A/BのD1を分離し、固定先への署名配送と永続的な再送拒否を確認する', async () => {
  const response = await probe(a, '/api/probes/run', { target: 'https://evil.invalid' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    reached: true,
    signed: true,
    d1: true,
    replayRejected: true,
  });
  const [own] = await connectD1(a.GAME_D1).select({ rows: count() }).from(probeRuns);
  const [peer] = await connectD1(b.GAME_D1).select({ rows: count() }).from(probeRuns);
  expect(own.rows).toBe(0);
  expect(peer.rows).toBe(1);
});

it('独立した2組織に各2インスタンスを作り、初期化の再送でも増やさない', async () => {
  for (const configuration of [a, b]) {
    const configured = {
      ...configuration,
      TEST_ADMIN_SUBJECT: `isolated-${configuration.TEST_NODE}`,
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await probe(configured, '/api/probes/database/setup');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        node: configuration.TEST_NODE,
        organizations: 1,
        instances: 2,
        gameReady: false,
      });
    }
  }
  const [own] = await connectD1(a.GAME_D1).select().from(organizations);
  const [peer] = await connectD1(b.GAME_D1).select().from(organizations);
  expect(own.id).not.toBe(peer.id);
  expect(own.identityNamespace).not.toBe(peer.identityNamespace);
  const all = [
    ...(await connectD1(a.GAME_D1).select().from(instances)),
    ...(await connectD1(b.GAME_D1).select().from(instances)),
  ];
  expect(new Set(all.map((instance) => instance.owner)).size).toBe(4);
  const unauthorized = await app.request(
    `${origins[0]}/api/probes/database/setup`,
    { method: 'POST' },
    { ...a, TEST_ADMIN_SUBJECT: 'isolated-A' },
  );
  expect(unauthorized.status).toBe(401);
});
it('検証操作は秘密トークンとOriginで守り、一般の対戦APIを公開しない', async () => {
  expect(
    (await app.request(`${origins[0]}/api/probes/run`, { method: 'POST' }, a)).status,
  ).toBe(401);
  const rejected = await app.request(
    `${origins[0]}/api/probes/run`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${a.PROBE_TOKEN}`, Origin: origins[1] },
    },
    a,
  );
  expect(rejected.status).toBe(403);
  expect((await app.request(`${origins[0]}/api/organization`, undefined, a)).status).toBe(
    404,
  );
  expect(
    await (await app.request(`${origins[0]}/api/health`, undefined, a)).json(),
  ).toMatchObject({ gameReady: false });
});
it('署名・宛先・期限違いは拒否し、nonceもDBへ保存しない', async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = { check: 'fixture' };
  const delivery = {
    protocolVersion: 1,
    messageType: 'probe',
    issuer: origins[0],
    audience: origins[1],
    issuedAt: now,
    expiresAt: now + 60,
    nonce: crypto.randomUUID(),
    method: 'POST',
    path: INBOX_PATH,
    bodyHash: await bodyHash(body),
    body,
  } as const;
  const other = await generateKeyPair('EdDSA');
  for (const [record, key] of [
    [delivery, other.privateKey],
    [{ ...delivery, audience: origins[0] }, signing.privateKey],
    [{ ...delivery, issuedAt: now - 120, expiresAt: now - 60 }, signing.privateKey],
  ] as const) {
    const message = await signDelivery(record, key, 'a-test');
    const response = await app.request(
      origins[1] + INBOX_PATH,
      {
        method: 'POST',
        body: JSON.stringify({ message }),
      },
      b,
    );
    expect(response.status).toBe(401);
  }
  const [saved] = await connectD1(b.GAME_D1).select({ rows: count() }).from(probeRuns);
  expect(saved.rows).toBe(0);
});
it('障害設定はA/Bを分離し、転送を拒否し、復旧後には新しい要求を受け付ける', async () => {
  await probe(b, '/api/probes/fault', { mode: 'unavailable' });
  expect((await probe(a, '/api/probes/run')).status).toBe(502);
  const [own] = await connectD1(a.GAME_D1).select({ rows: count() }).from(probeRuns);
  expect(own.rows).toBe(0);
  await probe(b, '/api/probes/fault', { mode: 'redirect' });
  expect(await (await probe(a, '/api/probes/run')).json()).toEqual({
    code: 'REDIRECT_REJECTED',
  });
  await probe(b, '/api/probes/fault', { mode: 'normal' });
  expect((await probe(a, '/api/probes/run')).status).toBe(200);
  const [fault] = await connectD1(b.GAME_D1)
    .select({ rows: count() })
    .from(probeRuns)
    .where(inArray(probeRuns.id, ['fault:redirect', 'fault:unavailable']));
  expect(fault.rows).toBe(0);
});
