import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import erasure from '../src/erasure/index';
import { eraseResultNames } from '../src/erasure/results';
import { changeD1, connectD1, rowsD1 } from '../src/worker/db/d1';
import {
  accountWithdrawals,
  difficultySamples,
  federationMetadataJobs,
  federationPeers,
  federationPolicies,
  federationQuestionImports,
  federationQuestionSources,
  instances,
  organizationAccounts,
  organizations,
  questionDifficulty,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import app from '../src/worker/index';
import { actorForSubject } from '../src/worker/organization/access';
import { setupOrganization } from '../src/worker/organization/database';
import { scheduledD1 } from '../src/worker/scheduled';
import { resetMatchmaker } from './fixtures/matchmaker';

vi.mock('../src/erasure/results', async (original) => ({
  ...(await original<typeof import('../src/erasure/results')>()),
  eraseResultNames: vi.fn(async () => 1),
}));
it('自己依頼は32バッチで止まり、次の要求で残りを再開する', async () => {
  let calls = 0;
  const environment = { GAME_D1: runtime.GAME_D1 } as Parameters<typeof erasure.fetch>[1];
  environment.ACCOUNT_ERASURE = {
    fetch: async (url: string, init: RequestInit) => {
      calls++;
      return erasure.fetch(new Request(url, init), environment);
    },
  } as unknown as Fetcher;
  const request = () =>
    new Request('https://private/maintenance', {
      method: 'POST',
      body: JSON.stringify({ task: 'results' }),
    });
  vi.mocked(eraseResultNames).mockClear();
  const response = await erasure.fetch(request(), environment);
  expect(response.status).toBe(503);
  expect(calls).toBe(31);
  expect(eraseResultNames).toHaveBeenCalledTimes(32);
  vi.mocked(eraseResultNames).mockResolvedValueOnce(0);
  expect((await erasure.fetch(request(), environment)).status).toBe(200);
});
const runtime = env as unknown as {
    GAME_D1: D1Database;
    D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  },
  db = connectD1(runtime.GAME_D1);
it('保守失敗は対象とコード位置を記録し、例外本文を公開しない', async () => {
  const error = new Error('D1_BUSY');
  error.stack = 'Error: private-value\n    at commit (index.js:133:9)';
  vi.mocked(eraseResultNames).mockRejectedValueOnce(error);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const instanceId = crypto.randomUUID();
    const response = await erasure.fetch(
      new Request('https://private/maintenance', {
        method: 'POST',
        body: JSON.stringify({ task: 'results', instanceId }),
      }),
      { GAME_D1: runtime.GAME_D1 } as Parameters<typeof erasure.fetch>[1],
    );
    expect(response.status).toBe(503);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      event: 'maintenance_failed',
      task: 'results',
      instanceId,
      code: 'D1_BUSY',
      locations: ['index.js:133:9'],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-value');
    expect(await response.json()).toEqual({ code: 'MAINTENANCE_FAILED' });
  } finally {
    log.mockRestore();
  }
});
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '定期検証',
    instanceName: '対象',
  });
});
it('CronはD1から直接処理し、保守DOを生成しない', async () => {
  const getByName = vi.fn();
  const fetch = vi.fn(async () => Response.json({ ready: true }));
  await app.scheduled(
    { cron: '0 19 * * *', scheduledTime: Date.now() } as ScheduledController,
    {
      GAME_D1: runtime.GAME_D1,
      ACCOUNT_ERASURE: { fetch },
      MATCHMAKER: { getByName },
    } as unknown as Env,
    {} as ExecutionContext,
  );
  expect(getByName).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalled();
  await expect(
    app.scheduled(
      { cron: '* * * * *' } as ScheduledController,
      {} as Env,
      {} as ExecutionContext,
    ),
  ).rejects.toThrow('UNKNOWN_SCHEDULE');
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
it('問題共有は日次だけで全対象を処理し、メタデータは毎時更新する', async () => {
  const [organization] = await db.select().from(organizations);
  const [instance] = await db.select().from(instances);
  const peers = Array.from({ length: 5 }, (_, index) => `https://peer-${index}.test`);
  const sources = peers.map((peerOrigin) => ({
    instanceId: instance.id,
    peerOrigin,
    sourceInstanceId: crypto.randomUUID(),
  }));
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(federationPeers).values(
        peers.map((origin) => ({
          origin,
          name: 'peer',
          kid: 'fixture',
          publicKey: 'fixture',
          approved: true,
        })),
      ),
      db.insert(federationMetadataJobs).values(
        peers.map((peerOrigin) => ({
          instanceId: organization.id,
          peerOrigin,
        })),
      ),
      db.insert(federationPolicies).values(
        sources.map((source) => ({
          id: crypto.randomUUID(),
          instanceId: source.instanceId,
          peerOrigin: source.peerOrigin,
          peerInstanceId: source.sourceInstanceId,
          receiveQuestions: true,
        })),
      ),
      db.insert(federationQuestionSources).values(sources),
      db.insert(federationQuestionImports).values(
        sources.map((source) => ({
          ...source,
          id: crypto.randomUUID(),
          config: {
            categories: [],
            targetCategoryId: crypto.randomUUID(),
            difficulty: { 0: 0, 1: 1, 2: 2 },
            fallback: 0,
          },
        })),
      ),
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
        const task = JSON.parse(String(init.body));
        received.push(task);
        if (task.task === 'federationQuestionSource' && task.peerOrigin === peers[0])
          return Response.json({ code: 'QUESTION_SYNC_UNAVAILABLE' }, { status: 503 });
        return Response.json({ ready: true });
      },
    },
  } as unknown as Env;
  await scheduledD1(environment);
  expect(received.filter((entry) => entry.task === 'federationMetadata')).toHaveLength(5);
  expect(received.some((entry) => entry.task === 'federationQuestions')).toBe(false);
  expect(received.some((entry) => entry.task === 'federationQuestionSource')).toBe(false);
  received.length = 0;
  await expect(scheduledD1(environment, Date.now(), 'daily')).rejects.toThrow(
    'MAINTENANCE_INCOMPLETE',
  );
  for (const task of ['federationQuestionSource', 'federationQuestions'])
    expect(received.filter((entry) => entry.task === task)).toHaveLength(5);
  expect(received.some((entry) => entry.task === 'federationMetadata')).toBe(false);
  received.length = 0;
  await expect(scheduledD1(environment, Date.now() + 3600000, 'hourly')).rejects.toThrow(
    'MAINTENANCE_INCOMPLETE',
  );
  for (const task of ['federationQuestionSource', 'federationQuestions'])
    expect(received.filter((entry) => entry.task === task)).toHaveLength(5);
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
    if (input.task === 'anonymization') throw new Error('isolated unavailable');
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
  expect(received.filter((task) => task.task === 'retention')).toHaveLength(0);
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(15);
  expect(responses.every((response) => response.bodyUsed)).toBe(true);
});

beforeEach(resetMatchmaker);

it('同じ日次実行の成功・残件あり・失敗を処理ごとに区別して記録する', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ ready: true }))
    .mockResolvedValueOnce(Response.json({ ready: false }, { status: 503 }))
    .mockRejectedValueOnce(new Error('failure'))
    .mockImplementation(async () => Response.json({ ready: true }));
  try {
    await expect(
      scheduledD1(
        {
          GAME_D1: runtime.GAME_D1,
          FEDERATION_ORIGIN: 'https://maintenance.test',
          SIGNING_KID: 'fixture',
          SIGNING_PRIVATE_KEY: 'fixture',
          ACCOUNT_ERASURE: { fetch },
        } as unknown as Env,
        Date.now(),
        'daily',
      ),
    ).rejects.toThrow('MAINTENANCE_INCOMPLETE');
    const events = log.mock.calls.map(([value]) => JSON.parse(value));
    const ended = events.filter((event) => event.phase === 'end');
    expect(ended.slice(0, 3).map((event) => event.outcome)).toEqual([
      'ok',
      'pending',
      'failed',
    ]);
    expect(ended.length).toBeGreaterThan(3);
    expect(new Set(events.map((event) => event.runId)).size).toBe(1);
    expect(events.every((event) => event.frequency === 'daily')).toBe(true);
    for (const end of ended)
      expect(
        events
          .filter((event) => event.taskIndex === end.taskIndex)
          .map((event) => event.phase),
      ).toEqual(['start', 'end']);
  } finally {
    log.mockRestore();
  }
});

it.each([
  'upstream unavailable',
  '{}',
  '{"ready":true}',
  '{"ready":false,"code":"D1_BUSY"}',
])('保守サービスの不正な503を未完了として処理する %s', async (body) => {
  const fetch = vi.fn(async () => new Response(body, { status: 503 }));
  const environment = {
    GAME_D1: runtime.GAME_D1,
    ACCOUNT_ERASURE: { fetch },
  } as unknown as Env;
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(scheduledD1(environment, Date.now(), 'daily')).rejects.toThrow(
      'MAINTENANCE_INCOMPLETE',
    );
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(logged).toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});

it('保守サービスが明示した残件ありの503だけは次回へ継続する', async () => {
  const fetch = vi.fn(async () => Response.json({ ready: false }, { status: 503 }));
  const environment = {
    GAME_D1: runtime.GAME_D1,
    ACCOUNT_ERASURE: { fetch },
  } as unknown as Env;
  await expect(scheduledD1(environment, Date.now(), 'daily')).resolves.toBeUndefined();
  expect(fetch.mock.calls.length).toBeGreaterThan(1);
});

it('日次難易度更新は3件目以降も処理し、失敗した対象が後続を止めない', async () => {
  const [organization] = await db.select().from(organizations);
  const scopes = Array.from({ length: 5 }, (_, index) => ({
    id: `difficulty-${index}`,
    organizationId: organization.id,
    owner: `difficulty-owner-${index}`,
    name: `難易度${index}`,
  }));
  await changeD1(db, async (writes) => {
    writes.push(
      db.insert(instances).values(scopes),
      db.insert(questionDifficulty).values(
        scopes.map((scope) => ({
          instanceId: scope.id,
          seriesId: 'series',
          generation: 'generation',
          current: 1,
        })),
      ),
      db.insert(difficultySamples).values(
        scopes.map((scope) => ({
          owner: scope.owner,
          generation: 'generation',
          band: 1,
          players: 4,
          rulesHash: 'rules',
          bandRevision: 1,
          trials: 1,
        })),
      ),
    );
  });
  const received: string[] = [];
  const environment = {
    GAME_D1: runtime.GAME_D1,
    QUESTION_DIFFICULTY_ENABLED: 'true',
    ACCOUNT_ERASURE: {
      fetch: async (_url: string, init: RequestInit) => {
        const task = JSON.parse(String(init.body));
        if (task.task === 'difficulty') {
          received.push(task.instanceId);
          if (task.instanceId === scopes[0].id) throw new Error('isolated failure');
        }
        return Response.json({ ready: true });
      },
    },
  } as unknown as Env;
  await scheduledD1(environment, Date.now(), 'hourly');
  expect(received).toEqual([]);
  await expect(scheduledD1(environment, Date.now(), 'daily')).rejects.toThrow(
    'MAINTENANCE_INCOMPLETE',
  );
  expect(received).toEqual(scopes.map((scope) => scope.id));
});

import { nextQuestionSyncAt } from '../src/shared/federation-questions';

it('問題同期の次回時刻は日本時間4時で、実行直後は翌日へ進む', () => {
  expect(
    new Date(nextQuestionSyncAt(Date.parse('2026-10-16T18:59:59Z'))).toISOString(),
  ).toBe('2026-10-16T19:00:00.000Z');
  expect(
    new Date(nextQuestionSyncAt(Date.parse('2026-10-16T19:00:00Z'))).toISOString(),
  ).toBe('2026-10-17T19:00:00.000Z');
});
