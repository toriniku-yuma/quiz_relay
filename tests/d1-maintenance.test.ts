import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import erasure from '../src/erasure/index';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  accountWithdrawals,
  federationMetadataJobs,
  federationPeers,
  organizationAccounts,
  organizations,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { refreshScheduledFederationMetadata } from '../src/worker/federation/metadata';
import app from '../src/worker/index';
import { actorForSubject } from '../src/worker/organization/access';
import { setupOrganization } from '../src/worker/organization/database';
import { scheduledD1 } from '../src/worker/scheduled';
import { resetMatchmaker } from './fixtures/matchmaker';

vi.mock('../src/worker/federation/metadata', async (original) => ({
  ...(await original<typeof import('../src/worker/federation/metadata')>()),
  refreshScheduledFederationMetadata: vi.fn(async () => ({ ok: true, nextCursor: null })),
}));

const runtime = env as unknown as {
    GAME_D1: D1Database;
    D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  },
  db = connectD1(runtime.GAME_D1);
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '定期検証',
    instanceName: '対象',
  });
});
it('Cron本体は保守完了まで待機し、背景処理へ渡して先に終了しない', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runMaintenance = vi.fn(() => pending);
  const getByName = vi.fn(() => ({ runMaintenance }));
  const waitUntil = vi.fn();
  let completed = false;
  const execution = app
    .scheduled(
      {} as ScheduledController,
      { MATCHMAKER: { getByName } } as unknown as Env,
      { waitUntil } as unknown as ExecutionContext,
    )
    .then(() => {
      completed = true;
    });
  await Promise.resolve();
  expect(completed).toBe(false);
  release();
  await execution;
  expect(completed).toBe(true);
  expect(getByName).toHaveBeenCalledExactlyOnceWith('maintenance');
  expect(waitUntil).not.toHaveBeenCalled();
});
it('再試行可能な保守DOの中断は新しいstubで一度だけ再試行する', async () => {
  const interrupted = Object.assign(new Error('platform interruption'), {
    retryable: true,
  });
  const first = { runMaintenance: vi.fn().mockRejectedValue(interrupted) };
  const second = { runMaintenance: vi.fn().mockResolvedValue(undefined) };
  const getByName = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
  await app.scheduled(
    {} as ScheduledController,
    { MATCHMAKER: { getByName } } as unknown as Env,
    {} as ExecutionContext,
  );
  expect(getByName).toHaveBeenCalledTimes(2);
  expect(first.runMaintenance).toHaveBeenCalledTimes(1);
  expect(second.runMaintenance).toHaveBeenCalledTimes(1);
});
it('過負荷と通常の業務エラーは再試行せず、再試行後の失敗も呼出元へ返す', async () => {
  for (const [error, expected] of [
    [new Error('MAINTENANCE_INCOMPLETE'), 1],
    [Object.assign(new Error('overload'), { retryable: true, overloaded: true }), 1],
    [Object.assign(new Error('interrupted again'), { retryable: true }), 2],
  ] as const) {
    const getByName = vi.fn(() => ({ runMaintenance: vi.fn().mockRejectedValue(error) }));
    await expect(
      app.scheduled(
        {} as ScheduledController,
        { MATCHMAKER: { getByName } } as unknown as Env,
        {} as ExecutionContext,
      ),
    ).rejects.toBe(error);
    expect(getByName).toHaveBeenCalledTimes(expected);
  }
});
it('定期処理専用DOの重なった呼出しで同じ保守処理を二重実行しない', async () => {
  const tasks = await runInDurableObject(
    (env as unknown as Env).MATCHMAKER.getByName('maintenance'),
    async (instance) => {
      const objectEnv = (instance as unknown as { env: Env }).env;
      const previous = objectEnv.ACCOUNT_ERASURE;
      const received: string[] = [];
      objectEnv.ACCOUNT_ERASURE = {
        fetch: async (_url: string, init: RequestInit) => {
          received.push(JSON.parse(String(init.body)).task);
          return Response.json({ ready: true });
        },
      } as unknown as Fetcher;
      try {
        await Promise.all([instance.runMaintenance(), instance.runMaintenance()]);
        return received;
      } finally {
        objectEnv.ACCOUNT_ERASURE = previous;
      }
    },
  );
  expect(tasks.filter((task) => task === 'reviews')).toHaveLength(1);
  expect(tasks.filter((task) => task === 'retention')).toHaveLength(1);
});
it('消去Workerは非公開の状態確認と既知の処理だけを受け付ける', async () => {
  const privateEnv = { GAME_D1: runtime.GAME_D1 } as Parameters<typeof erasure.fetch>[1];
  const status = await erasure.fetch(
    new Request('https://private/status', { method: 'POST' }),
    privateEnv,
  );
  expect(await status.json()).toMatchObject({
    pendingAuthentication: 0,
    pendingAnonymization: 0,
    pendingInstanceDeletion: 0,
  });
  expect(
    (await erasure.fetch(new Request('https://private/status'), privateEnv)).status,
  ).toBe(404);
  expect(
    (
      await erasure.fetch(
        new Request('https://private/maintenance', {
          method: 'POST',
          body: JSON.stringify({ task: 'arbitrary-sql' }),
        }),
        privateEnv,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await erasure.fetch(
        new Request('https://private/withdrawal', {
          method: 'POST',
          body: JSON.stringify({ operationId: 'bad' }),
        }),
        privateEnv,
      )
    ).status,
  ).toBe(400);
});
it('メタデータ同期は保守DOで実行し、HTTP消去Workerへ送らない', async () => {
  const [organization] = await db.select().from(organizations);
  const peerOrigin = 'https://maintenance-peer.test';
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(federationPeers).values({
        origin: peerOrigin,
        name: 'peer',
        kid: 'fixture',
        publicKey: 'fixture',
        approved: true,
      }),
      db
        .insert(federationMetadataJobs)
        .values({ instanceId: organization.id, peerOrigin }),
    );
  });
  const received: Record<string, unknown>[] = [];
  const environment = {
    GAME_D1: runtime.GAME_D1,
    FEDERATION_ORIGIN: 'https://maintenance.test',
    SIGNING_KID: 'fixture',
    SIGNING_PRIVATE_KEY: 'fixture',
    ACCOUNT_ERASURE: {
      fetch: async (_url: string, init: RequestInit) => {
        received.push(JSON.parse(String(init.body)));
        return Response.json({ ready: true });
      },
    },
  } as unknown as Env;
  await scheduledD1(environment);
  const calls = vi.mocked(refreshScheduledFederationMetadata).mock.calls;
  expect(calls.map(([, instanceId, peer]) => ({ instanceId, peer }))).toEqual([
    { instanceId: organization.id, peer: peerOrigin },
  ]);
  expect(calls[0][0] === environment).toBe(true);
  expect(received.some((task) => task.task === 'federationMetadata')).toBe(false);
});
it('未処理が100件あっても1回の定期呼出しでは処理を小分けにし、エラーが他の処理を止めない', async () => {
  const [organization] = await db.select().from(organizations),
    now = new Date().toISOString();
  const accounts = await Promise.all(
    Array.from({ length: 100 }, async () => {
      const subject = crypto.randomUUID();
      return {
        subject,
        organizationId: organization.id,
        actorId: await actorForSubject(organization.identityNamespace, subject),
        withdrawnAt: now,
      };
    }),
  );
  await changeD1(db, async (writes) => {
    writes.push(
      rowsD1(organizationAccounts, accounts),
      rowsD1(
        accountWithdrawals,
        accounts.map((account) => ({
          id: crypto.randomUUID(),
          organizationId: organization.id,
          actorId: account.actorId,
          requestedAt: now,
          retryAt: now,
        })),
      ),
    );
  });
  const received: Record<string, unknown>[] = [];
  const responses: Response[] = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    received.push(input);
    if (input.task === 'authentication')
      return Response.json({ ready: false }, { status: 503 });
    if (input.task === 'reviews') throw new Error('isolated unavailable');
    const response = Response.json({ ready: true });
    responses.push(response);
    return response;
  });
  const environment = {
    GAME_D1: runtime.GAME_D1,
    ACCOUNT_ERASURE: { fetch },
  } as unknown as Env;
  await expect(scheduledD1(environment)).rejects.toThrow('MAINTENANCE_INCOMPLETE');
  expect(received.filter((task) => task.task === 'authentication')).toHaveLength(2);
  expect(received.filter((task) => task.task === 'anonymization')).toHaveLength(2);
  expect(received.filter((task) => task.task === 'retention')).toHaveLength(1);
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(15);
  expect(responses.every((response) => response.bodyUsed)).toBe(true);
});

beforeEach(resetMatchmaker);
