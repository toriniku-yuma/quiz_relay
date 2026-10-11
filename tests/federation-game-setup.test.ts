import { applyD1Migrations, env } from 'cloudflare:test';
import { count, eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import app from '../scripts/federation-game-worker';
import type { FederationTestEnv } from '../scripts/federation-worker';
import { connectD1 } from '../src/worker/db/d1';
import {
  federationPeers,
  instances,
  organizations,
  questionVersions,
} from '../src/worker/db/schema';
import { setupOrganization } from '../src/worker/organization/database';

const runtime = env as unknown as FederationTestEnv & {
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const origin = 'https://quiz-relay-federation-a-test.quiz-relay.workers.dev';
const testEnv = {
  ...runtime,
  TEST_NODE: 'A',
  TEST_ADMIN_SUBJECT: 'qa-admin',
  GAME_OWNER: origin,
  PROBES_ENABLED: 'true',
  PROBE_TOKEN: 'a'.repeat(64),
};
const db = connectD1(runtime.GAME_D1);
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(
    db,
    { ...testEnv, INITIAL_ADMIN_SUBJECT: 'qa-admin' },
    'qa-admin',
    {
      name: '連携検証 A',
      instanceName: 'A-1',
    },
  );
});
it('QA初期化は保護され、実ゲーム用の不変カタログを一度だけ作る', async () => {
  const [instance] = await db.select().from(instances);
  const request = (token: string, instanceId = instance.id) =>
    app.request(
      `${origin}/api/probes/game/setup`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId }),
      },
      testEnv,
    );
  expect((await request('invalid')).status).toBe(401);
  expect((await request(testEnv.PROBE_TOKEN, crypto.randomUUID())).status).toBe(403);
  const first = await request(testEnv.PROBE_TOKEN);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ gameReady: true, seeded: true });
  const [before] = await db.select({ rows: count() }).from(questionVersions);
  const second = await request(testEnv.PROBE_TOKEN);
  expect(await second.json()).toMatchObject({ seeded: false });
  const [after] = await db.select({ rows: count() }).from(questionVersions);
  expect(before.rows).toBeGreaterThan(0);
  expect(after.rows).toBe(before.rows);
});
it('共有検証の作問データもQA専用の対象に限定し、再実行で増やさない', async () => {
  const [instance] = await db.select().from(instances);
  const request = (token: string, instanceId = instance.id) =>
    app.request(
      `${origin}/api/probes/game/questions-seed`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId }),
      },
      { ...testEnv, GAME_CONFIG_PROFILE: 'local' },
    );
  expect((await request('invalid')).status).toBe(401);
  expect((await request(testEnv.PROBE_TOKEN, crypto.randomUUID())).status).toBe(403);
  const response = await request(testEnv.PROBE_TOKEN);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ seeded: true });
  expect(await (await request(testEnv.PROBE_TOKEN)).json()).toMatchObject({
    seeded: false,
  });
});
it('クラウド状態確認は認証とOriginを検査し、問題本文や秘密を返さない', async () => {
  const request = (token: string, requestOrigin = origin) =>
    app.request(
      `${origin}/api/probes/game/status`,
      { headers: { Authorization: `Bearer ${token}`, Origin: requestOrigin } },
      testEnv,
    );
  expect((await request('invalid')).status).toBe(401);
  expect((await request(testEnv.PROBE_TOKEN, 'https://evil.invalid')).status).toBe(403);
  const response = await request(testEnv.PROBE_TOKEN);
  expect(response.status).toBe(200);
  const status = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(status).sort()).toEqual([
    'gameReady',
    'imports',
    'instances',
    'metadata',
    'node',
  ]);
  expect(status.metadata).toEqual([]);
  expect(status.imports).toEqual([]);
  expect(JSON.stringify(status)).not.toContain(testEnv.PROBE_TOKEN);
  expect(JSON.stringify(status)).not.toContain('answer');
});

it('結果保存の診断もQA管理者と対象インスタンスに限定する', async () => {
  const [instance] = await db.select().from(instances);
  const request = (token: string, instanceId = instance.id) =>
    app.request(
      `${origin}/api/probes/game/persistence`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId }),
      },
      testEnv,
    );
  expect((await request('invalid')).status).toBe(401);
  expect((await request(testEnv.PROBE_TOKEN, crypto.randomUUID())).status).toBe(403);
  const response = await request(testEnv.PROBE_TOKEN);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ rooms: [] });
});

it('配送診断は自側QAインスタンスとprobe認証に限定する', async () => {
  const [instance] = await db.select().from(instances);
  const request = (token: string, instanceId = instance.id, extra = {}) =>
    app.request(
      `${origin}/api/probes/game/deliveries`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instanceId, ...extra }),
      },
      testEnv,
    );
  expect((await request('invalid')).status).toBe(401);
  expect((await request(testEnv.PROBE_TOKEN, crypto.randomUUID())).status).toBe(403);
  expect(
    (await request(testEnv.PROBE_TOKEN, instance.id, { payload: true })).status,
  ).toBe(400);
  expect(await (await request(testEnv.PROBE_TOKEN)).json()).toEqual({ deliveries: [] });
});

it('DB単独の疎通確認は固定のQA配置だけに限定し、データを公開しない', async () => {
  const request = (token: string, owner = origin) =>
    app.request(
      `${origin}/api/probes/game/database-read`,
      { headers: { Authorization: `Bearer ${token}` } },
      { ...testEnv, GAME_OWNER: owner },
    );
  expect((await request('invalid')).status).toBe(401);
  expect((await request(testEnv.PROBE_TOKEN, 'https://other.example')).status).toBe(403);
  expect(await (await request(testEnv.PROBE_TOKEN)).json()).toMatchObject({
    ready: true,
  });
});
it('負荷試験の本人fixtureはQA専用配置・正しいtoken・新規runId・人数上限に限定する', async () => {
  const request = (input: object, token = testEnv.PROBE_TOKEN, owner = origin) =>
    app.request(
      `${origin}/api/probes/game/load/enter`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { ...testEnv, GAME_OWNER: owner },
    );
  const input = {
    runId: crypto.randomUUID(),
    index: 0,
    operationId: crypto.randomUUID(),
    mode: 'ranked',
  };
  expect((await request(input, 'invalid')).status).toBe(401);
  expect(
    (await request(input, testEnv.PROBE_TOKEN, 'https://production.invalid')).status,
  ).toBe(403);
  expect((await request({ ...input, index: 13 })).status).toBe(400);
  expect((await request({ ...input, runId: 'existing-user' })).status).toBe(400);
});
it('片側未承認の検証はBの固定peerだけを変更し、鍵を維持して競合と未認証を拒否する', async () => {
  const [organization] = await db.select().from(organizations);
  const baseline = { approved: true, discovered: false, participationBlocked: false };
  await db.insert(federationPeers).values({
    origin,
    name: 'QA A',
    kid: 'qa-key',
    publicKey: 'unchanged-key',
    ...baseline,
  });
  const bOrigin = 'https://quiz-relay-federation-b-test.quiz-relay.workers.dev';
  const request = (body: object, token = testEnv.PROBE_TOKEN, peer = origin) =>
    app.request(
      `${bOrigin}/api/probes/game/peer-state`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      },
      { ...testEnv, TEST_NODE: 'B', GAME_OWNER: bOrigin, PEER_ORIGIN: peer },
    );
  expect((await request({}, 'invalid')).status).toBe(401);
  expect((await request({})).status).toBe(403);
  await db
    .update(organizations)
    .set({ name: '連携検証 B' })
    .where(eq(organizations.id, organization.id));
  try {
    expect((await request({}, testEnv.PROBE_TOKEN, 'https://other.invalid')).status).toBe(
      403,
    );
    expect(await (await request({})).json()).toEqual(baseline);
    const unapproved = { approved: false, discovered: true, participationBlocked: false };
    expect(
      (
        await request({
          expected: baseline,
          next: { ...unapproved, publicKey: 'changed' },
        })
      ).status,
    ).toBe(400);
    expect((await request({ expected: unapproved, next: baseline })).status).toBe(409);
    expect(
      await (await request({ expected: baseline, next: unapproved })).json(),
    ).toEqual(unapproved);
    expect(
      await (await request({ expected: unapproved, next: baseline })).json(),
    ).toEqual(baseline);
    const [peer] = await db
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.origin, origin));
    expect(peer.publicKey).toBe('unchanged-key');
    expect(peer.kid).toBe('qa-key');
  } finally {
    await db
      .update(organizations)
      .set({ name: organization.name })
      .where(eq(organizations.id, organization.id));
  }
});
