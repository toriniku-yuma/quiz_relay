import { applyD1Migrations, env } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { expireSharedQuestions } from '../src/erasure/shared-questions';
import type { QuestionSharingOverview } from '../src/shared/federation-questions';
import { defaultQuestionSettings, emptyQuestion } from '../src/shared/questions';
import { loadMatchDefinition } from '../src/worker/catalog/database';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import {
  federationPeers,
  federationPolicies,
  federationQuestionImports,
  federationQuestionLinks,
  instances,
  questionCategories,
  questionDifficulty,
  questionSettings,
  questionSubmissions,
  questionVersions,
} from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { preparePeer, publicPeerKey } from '../src/worker/federation/discovery';
import {
  dueQuestionImports,
  syncQuestionImport,
} from '../src/worker/federation/question-imports';
import { questionSharing } from '../src/worker/federation/question-management';
import { exportSharedQuestions } from '../src/worker/federation/question-source';
import {
  cachedQuestionSource,
  refreshQuestionSource,
} from '../src/worker/federation/question-sources';
import app from '../src/worker/index';
import {
  addInstance,
  organizationIdentity,
  setupOrganization,
} from '../src/worker/organization/database';
import { saveProfile } from '../src/worker/organization/profile';
import { publishQuestionCatalog } from '../src/worker/questions/catalog';
import { QuestionPlan } from '../src/worker/questions/plan';
import { questionOverview } from '../src/worker/questions/read';
import { questionMutation } from '../src/worker/questions/write';

const runtime = env as unknown as {
  GAME_D1: D1Database;
  PEER_D1: D1Database;
  D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
function metered(database: D1Database) {
  const usage = { read: 0, written: 0 };
  const add = (result: D1Result) => {
    usage.read += result.meta.rows_read;
    usage.written += result.meta.rows_written;
  };
  const statement = (prepared: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(prepared, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'bind')
          return (...values: unknown[]) => statement(target.bind(...values));
        if (key === 'all' || key === 'run')
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            add(result);
            return result;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const measured = new Proxy(database, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
      if (key === 'batch')
        return async (queries: D1PreparedStatement[]) => {
          const results = await target.batch(queries);
          results.forEach(add);
          return results;
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { database: measured, usage };
}
const hostMeter = metered(runtime.GAME_D1),
  sourceMeter = metered(runtime.PEER_D1);
const hostDb = connectD1(hostMeter.database),
  sourceDb = connectD1(sourceMeter.database),
  sourceOrigin = 'https://source.quiz-relay.workers.dev',
  hostOrigin = 'https://host.quiz-relay.workers.dev';
let source: Env,
  host: Env,
  sourceId: string,
  hostId: string,
  sourceCategory: string,
  hostCategory: string,
  hostOwner: string,
  importId: string,
  queryCount = 0;
const unlimited: RateLimit = { limit: async () => ({ success: true }) };
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await applyD1Migrations(runtime.PEER_D1, runtime.D1_MIGRATIONS);
  const sourceKeys = await generateKeyPair('EdDSA', { extractable: true }),
    hostKeys = await generateKeyPair('EdDSA', { extractable: true });
  const counted = new Proxy(hostMeter.database, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'prepare')
        return (query: string) => {
          queryCount++;
          return target.prepare(query);
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  source = {
    ...env,
    GAME_CONFIG_PROFILE: 'local',
    FEDERATION_LIMITER: unlimited,
    GAME_D1: sourceMeter.database,
    FEDERATION_ORIGIN: sourceOrigin,
    SIGNING_KID: 'source',
    SIGNING_PRIVATE_KEY: await exportPKCS8(sourceKeys.privateKey),
  } as Env;
  host = {
    ...env,
    GAME_CONFIG_PROFILE: 'local',
    FEDERATION_LIMITER: unlimited,
    GAME_D1: counted,
    FEDERATION_ORIGIN: hostOrigin,
    SIGNING_KID: 'host',
    SIGNING_PRIVATE_KEY: await exportPKCS8(hostKeys.privateKey),
  } as Env;
  host.ACCOUNT_ERASURE = {
    fetch: async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body)) as { importId: string };
      const publicQueries = queryCount;
      queryCount = 0;
      try {
        const result = await syncQuestionImport(host, input.importId);
        expect(queryCount).toBeLessThanOrEqual(50);
        return Response.json({ ready: true, ...result });
      } finally {
        queryCount = publicQueries;
      }
    },
  } as unknown as Env['ACCOUNT_ERASURE'];
  await setupOrganization(
    sourceDb,
    { INITIAL_ADMIN_SUBJECT: 'source-admin' } as Env,
    'source-admin',
    { name: '共有元', instanceName: '共有元' },
  );
  await setupOrganization(
    hostDb,
    { INITIAL_ADMIN_SUBJECT: 'host-admin' } as Env,
    'host-admin',
    { name: '取込先', instanceName: '取込先' },
  );
  sourceId = (await sourceDb.select().from(instances))[0].id;
  const [instance] = await hostDb.select().from(instances);
  hostId = instance.id;
  hostOwner = instance.owner;
  sourceCategory = crypto.randomUUID();
  hostCategory = crypto.randomUUID();
  importId = crypto.randomUUID();
  for (const [db, id, category, origin, key, kid] of [
    [
      sourceDb,
      sourceId,
      sourceCategory,
      hostOrigin,
      await exportSPKI(hostKeys.publicKey),
      'host',
    ],
    [
      hostDb,
      hostId,
      hostCategory,
      sourceOrigin,
      await exportSPKI(sourceKeys.publicKey),
      'source',
    ],
  ] as const) {
    await changeD1(db, async (writes) => {
      writes.push(
        db.update(instances).set({ state: 'published' }),
        db.insert(questionSettings).values({
          instanceId: id,
          config: { ...defaultQuestionSettings, showAuthor: true },
        }),
        db
          .insert(questionCategories)
          .values({ instanceId: id, id: category, name: '通常' }),
        db
          .insert(federationPeers)
          .values({ origin, name: '相手', kid, publicKey: key, approved: true }),
        db.insert(federationPolicies).values({
          id: crypto.randomUUID(),
          instanceId: id,
          peerOrigin: origin,
          peerInstanceId: id === sourceId ? hostId : sourceId,
          sendQuestions: true,
          receiveQuestions: true,
        }),
      );
    });
  }
  const owner = (await sourceDb.select().from(instances))[0].owner,
    { account } = await organizationIdentity(sourceDb, 'source-admin');
  await changeD1(sourceDb, async (writes) => {
    const plan = new QuestionPlan(sourceId, owner);
    await plan.load(sourceDb, { operation: 'seed' });
    for (let i = 0; i < 27; i++) {
      let row = plan.draft(account.actorId, '共有作者', {
        ...emptyQuestion(),
        text: `共有問題${i}`,
        displayAnswer: 'あ',
        readings: ['あ'],
        explanation: '解説',
        evidence: '非公開の確認資料',
        source: '独自作成',
        categoryId: sourceCategory,
        difficulty: 0,
      });
      row = plan.save(row, { status: 'approved', publishedId: await plan.publish(row) });
    }
    plan.flush(writes);
    await publishQuestionCatalog(sourceDb, writes, sourceId, owner, 'local', 2, {
      submissions: [...plan.changedSubmissions.values()],
      questions: plan.newVersions,
      availability: [...plan.availability.values()],
    });
  });
});
afterEach(() => vi.restoreAllMocks());
const configure = (extra: Record<string, unknown> = {}) =>
  questionSharing(host, 'host-admin', {
    operation: 'import',
    instanceId: hostId,
    id: importId,
    revision: 0,
    peerOrigin: sourceOrigin,
    sourceInstanceId: sourceId,
    enabled: true,
    config: {
      categories: [],
      targetCategoryId: hostCategory,
      difficulty: { '0': 0, '1': 1, '2': 2 },
      fallback: 0,
    },
    ...extra,
  });
const sync = async () => {
  queryCount = 0;
  const result = await syncQuestionImport(host, importId);
  expect(queryCount).toBeLessThanOrEqual(50);
  return result;
};
async function complete() {
  for (let i = 0; i < 10; i++) {
    const result = await sync();
    if (!result.pending) return;
  }
  throw new Error('SYNC_DID_NOT_COMPLETE');
}
it('インスタンス単位の共有許可・権限・固定ページ・クエリ数を検査し、通常カタログに取り込む', async () => {
  await expect(
    questionSharing(host, 'member', { operation: 'overview', instanceId: hostId }),
  ).rejects.toThrow('REVIEW_FORBIDDEN');
  expect(
    (
      await exportSharedQuestions(sourceDb, hostOrigin, {
        sourceInstanceId: sourceId,
        targetInstanceId: hostId,
      })
    ).questions,
  ).toHaveLength(25);
  await changeD1(sourceDb, async (writes) => {
    const [policy] = await sourceDb.select().from(federationPolicies);
    writes.push(
      sourceDb
        .update(federationPolicies)
        .set({ sendQuestions: true })
        .where(eq(federationPolicies.id, policy.id)),
    );
  });
  const page = await exportSharedQuestions(sourceDb, hostOrigin, {
    sourceInstanceId: sourceId,
    targetInstanceId: hostId,
  });
  expect(page.questions).toHaveLength(25);
  expect(page.nextCursor).not.toBeNull();
  expect(JSON.stringify(page)).not.toContain('非公開の確認資料');
  await configure();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) =>
      app.request(input as Request, undefined, source),
    );
  expect((await sync()).pending).toBe(true);
  const [progress] = await hostDb
    .select()
    .from(federationQuestionImports)
    .where(eq(federationQuestionImports.id, importId));
  expect(progress.cursor).not.toBeNull();
  expect(progress.snapshot).not.toBeNull();
  fetcher.mockRejectedValueOnce(new Error('offline'));
  await expect(sync()).rejects.toThrow('FEDERATION_PEER_UNAVAILABLE');
  const [failed] = await hostDb
    .select()
    .from(federationQuestionImports)
    .where(eq(federationQuestionImports.id, importId));
  expect(failed.cursor).toBe(progress.cursor);
  expect(failed.snapshot).toBe(progress.snapshot);
  expect(await dueQuestionImports(host, Date.now() + 3600000, true)).toContainEqual({
    id: importId,
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 3600000);
  try {
    await complete();
  } finally {
    vi.useRealTimers();
  }
  const beforeRenew = await hostDb.select().from(questionSubmissions);
  expect((await sync()).pending).toBe(false);
  expect(await hostDb.select().from(questionSubmissions)).toEqual(beforeRenew);
  const definition = await loadMatchDefinition(host, {
    owner: hostOwner,
    profile: 'local',
  });
  expect(definition.questions).toHaveLength(27);
  expect(
    definition.questions.every((question) => question.categoryId === hostCategory),
  ).toBe(true);
  expect(await hostDb.select().from(federationQuestionLinks)).toHaveLength(27);
  await expect(configure({ id: crypto.randomUUID() })).rejects.toThrow(
    'QUESTION_IMPORT_OVERLAP',
  );
});
it('途中取得の版変更を署名付き応答で識別し、古いcursorを破棄して新しい版を取得する', async () => {
  const page = await exportSharedQuestions(sourceDb, hostOrigin, {
    sourceInstanceId: sourceId,
    targetInstanceId: hostId,
  });
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .update(federationQuestionImports)
        .set({ snapshot: page.snapshot, cursor: page.nextCursor })
        .where(eq(federationQuestionImports.id, importId)),
    );
  });
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .update(instances)
        .set({ operationRevision: sql`${instances.operationRevision}+1` })
        .where(eq(instances.id, sourceId)),
    );
  });
  const responses: Response[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const response = await app.request(input as Request, undefined, source);
    responses.push(response.clone());
    return response;
  });
  await expect(sync()).rejects.toThrow('QUESTION_SNAPSHOT_CHANGED');
  expect(responses[0].status).toBe(200);
  expect(await responses[0].json()).toEqual({ message: expect.any(String) });
  const [failed] = await hostDb
    .select()
    .from(federationQuestionImports)
    .where(eq(federationQuestionImports.id, importId));
  expect(failed.cursor).toBeNull();
  expect(failed.snapshot).toBeNull();
  expect(failed.errorCode).toBe('QUESTION_SNAPSHOT_CHANGED');
  await complete();
  expect(await hostDb.select().from(federationQuestionLinks)).toHaveLength(27);
});

it('共有同期の変更なし・1問変更のD1行数を計測し、無変更で本文を書き換えない', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    app.request(input as Request, undefined, source),
  );
  await complete();
  const resetUsage = () => {
    for (const meter of [hostMeter, sourceMeter]) {
      meter.usage.read = 0;
      meter.usage.written = 0;
    }
  };
  resetUsage();
  await complete();
  const unchanged = { source: { ...sourceMeter.usage }, host: { ...hostMeter.usage } };
  const [row] = await sourceDb.select().from(questionSubmissions).limit(1);
  await changeD1(sourceDb, async (writes) => {
    const [instance] = await sourceDb
      .select()
      .from(instances)
      .where(eq(instances.id, sourceId));
    const plan = new QuestionPlan(sourceId, instance.owner);
    await plan.load(sourceDb, { operation: 'seed' });
    let revised = plan.save(row, {
      input: { ...row.input, explanation: '改訂した解説' },
      revision: row.revision + 1,
    });
    revised = plan.save(revised, { publishedId: await plan.publish(revised) });
    plan.flush(writes);
    await publishQuestionCatalog(
      sourceDb,
      writes,
      sourceId,
      instance.owner,
      'local',
      undefined,
      {
        submissions: [...plan.changedSubmissions.values()],
        questions: plan.newVersions,
        availability: [...plan.availability.values()],
      },
    );
  });
  resetUsage();
  await complete();
  const changed = { source: { ...sourceMeter.usage }, host: { ...hostMeter.usage } };
  expect(unchanged.source.read + unchanged.host.read).toBeLessThan(500);
  expect(unchanged.host.written).toBeLessThanOrEqual(10);
  expect(changed.source.read + changed.host.read).toBeLessThan(2500);
  expect(changed.host.written).toBeLessThan(750);
  expect(unchanged.source.read).toBeGreaterThan(0);
  expect(unchanged.host.written).toBeLessThan(changed.host.written);
});

it('カテゴリ候補の画面取得はキャッシュだけを読み、定期取得は5分以内に繰り返さない', async () => {
  const scope = {
    instanceId: hostId,
    peerOrigin: sourceOrigin,
    sourceInstanceId: sourceId,
  };
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) =>
      app.request(input as Request, undefined, source),
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    expect(await cachedQuestionSource(hostDb, scope)).toMatchObject({
      ready: false,
      categories: [],
    });
  }
  expect(fetcher).not.toHaveBeenCalled();
  await Promise.all([
    refreshQuestionSource(host, scope),
    refreshQuestionSource(host, scope),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await cachedQuestionSource(hostDb, scope)).toMatchObject({
    ready: true,
    categories: [{ id: sourceCategory, name: '通常' }],
  });
  await refreshQuestionSource(host, scope);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    (
      await exportSharedQuestions(sourceDb, hostOrigin, {
        sourceInstanceId: sourceId,
        targetInstanceId: hostId,
        categoriesOnly: true,
      })
    ).questions,
  ).toEqual([]);
});
it('URLで公開鍵を取得し、通常の確認は承認・固定鍵・参加制限を変更しない', async () => {
  const origin = 'https://new-source.quiz-relay.workers.dev',
    key = { ...publicPeerKey(source), origin };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(key));
  await expect(
    preparePeer(host, 'member', { operation: 'preparePeer', origin, rotate: false }),
  ).rejects.toThrow('ADMIN_REQUIRED');
  expect(fetcher).not.toHaveBeenCalled();
  const candidate = await preparePeer(host, 'host-admin', {
    operation: 'preparePeer',
    origin,
    rotate: false,
  });
  expect(candidate.approved).toBe(false);
  expect(candidate.publicKey.trim()).toBe(key.publicKey.trim());
  fetcher.mockResolvedValue(Response.json({ ...key, kid: 'new-key' }));
  await preparePeer(host, 'host-admin', {
    operation: 'preparePeer',
    origin,
    rotate: false,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    (
      await preparePeer(host, 'host-admin', {
        operation: 'preparePeer',
        origin,
        rotate: true,
      })
    ).kid,
  ).toBe('new-key');
  expect(
    (
      await hostDb
        .select()
        .from(federationPeers)
        .where(eq(federationPeers.origin, origin))
    )[0].kid,
  ).toBe(key.kid);
});
it('作者の表示名変更で共有版を更新し、共有先の作者名を同期する', async () => {
  const request = { sourceInstanceId: sourceId, targetInstanceId: hostId };
  const before = await exportSharedQuestions(sourceDb, hostOrigin, request);
  const [imported] = await hostDb
    .select()
    .from(federationQuestionImports)
    .where(eq(federationQuestionImports.id, importId));
  expect(imported.activeSnapshot).toBe(before.snapshot);

  await saveProfile(
    sourceDb,
    'source-admin',
    {
      displayName: '共有作者の新しい名前',
      revision: 0,
    },
    'local',
  );
  const after = await exportSharedQuestions(sourceDb, hostOrigin, request);
  expect(after.snapshot).not.toBe(before.snapshot);
  expect(
    after.questions.every((question) => question.authorName === '共有作者の新しい名前'),
  ).toBe(true);
  await expect(
    exportSharedQuestions(sourceDb, hostOrigin, {
      ...request,
      cursor: before.nextCursor,
      snapshot: before.snapshot,
    }),
  ).rejects.toThrow('QUESTION_SNAPSHOT_CHANGED');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    app.request(input as Request, undefined, source),
  );
  await complete();
  const questions = await hostDb.select().from(questionSubmissions);
  expect(questions).toHaveLength(27);
  expect(
    questions.every((question) => question.authorName === '共有作者の新しい名前'),
  ).toBe(true);
  expect(
    questions.every((question) => question.provenance?.author === '共有作者の新しい名前'),
  ).toBe(true);
});

it('設定更新中も共有ページの公開名・カテゴリ・問題を同じ版から返す', async () => {
  const [instance] = await sourceDb
    .select()
    .from(instances)
    .where(eq(instances.id, sourceId));
  const [category] = await sourceDb
    .select()
    .from(questionCategories)
    .where(eq(questionCategories.id, sourceCategory));
  const rename = (name: string, categoryName = name) =>
    changeD1(sourceDb, async (writes) => {
      writes.push(
        sourceDb.update(instances).set({ name }).where(eq(instances.id, sourceId)),
        sourceDb
          .update(questionCategories)
          .set({ name: categoryName, revision: sql`${questionCategories.revision}+1` })
          .where(eq(questionCategories.id, sourceCategory)),
      );
    });
  await rename('版0');
  try {
    const update = async () => {
      for (let version = 1; version <= 12; version++) await rename(`版${version}`);
    };
    const read = async () => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const page = await exportSharedQuestions(sourceDb, hostOrigin, {
          sourceInstanceId: sourceId,
          targetInstanceId: hostId,
        });
        expect(page.questions).toHaveLength(25);
        expect(page.categories).toEqual([{ id: sourceCategory, name: page.sourceName }]);
        expect(
          page.questions.every((question) => question.category.name === page.sourceName),
        ).toBe(true);
      }
    };
    await Promise.all([update(), read()]);
  } finally {
    await rename(instance.name, category.name);
  }
});

it('個別除外と開催先補正を改訂・同期後も保持し、取得失敗や共有解除を新規試合へ反映する', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    app.request(input as Request, undefined, source),
  );
  const [link] = await hostDb.select().from(federationQuestionLinks);
  const [excludedRow] = await hostDb
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.id, link.submissionId));
  await questionMutation(hostDb, 'host-admin', hostId, {
    operation: 'exclude-shared',
    id: link.submissionId,
    revision: excludedRow.revision,
    excluded: true,
  });
  const [second] = await hostDb
    .select()
    .from(federationQuestionLinks)
    .where(eq(federationQuestionLinks.excluded, false));
  const [row] = await hostDb
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.id, second.submissionId));
  await questionMutation(
    hostDb,
    'host-admin',
    hostId,
    {
      operation: 'difficulty',
      changes: [{ id: row.id, revision: row.revision, difficulty: 1, fixed: true }],
      reason: '運用補正',
    },
    'local',
  );
  const fixed = await loadMatchDefinition(host, {
    owner: hostOwner,
    profile: 'local-casual',
  });
  expect(fixed.questions).toHaveLength(26);
  expect(
    fixed.questions.find((question) => question.seriesId === row.seriesId)?.difficulty,
  ).toBe(1);
  await expect(
    questionMutation(
      hostDb,
      'host-admin',
      hostId,
      { operation: 'save', id: row.id, revision: row.revision, input: row.input },
      'local',
    ),
  ).rejects.toThrow();
  const [sourceInstance] = await sourceDb.select().from(instances);
  const [original] = await sourceDb
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.seriesId, link.sourceSeriesId));
  await changeD1(sourceDb, async (writes) => {
    const plan = new QuestionPlan(sourceId, sourceInstance.owner);
    await plan.load(sourceDb, { operation: 'shared-revision', ids: [original.id] });
    const updated = plan.save(original, {
      input: { ...original.input, text: '共有問題の実改訂' },
      revision: original.revision + 1,
    });
    plan.save(updated, { publishedId: await plan.publish(updated) });
    plan.flush(writes);
  });
  await complete();
  expect(
    (
      await hostDb
        .select()
        .from(federationQuestionLinks)
        .where(eq(federationQuestionLinks.submissionId, link.submissionId))
    )[0].excluded,
  ).toBe(true);
  expect(
    (
      await hostDb
        .select()
        .from(questionDifficulty)
        .where(eq(questionDifficulty.seriesId, row.seriesId))
    )[0].current,
  ).toBe(1);
  vi.mocked(globalThis.fetch).mockRejectedValue(new Error('offline'));
  await expect(syncQuestionImport(host, importId)).rejects.toThrow();
  await expect(
    loadMatchDefinition(host, { owner: hostOwner, profile: 'local' }),
  ).rejects.toThrow('NO_RANKED_QUESTIONS');
  expect(fixed.questions).toHaveLength(26);
  vi.mocked(globalThis.fetch).mockImplementation(async (input) =>
    app.request(input as Request, undefined, source),
  );
  await complete();
  await changeD1(sourceDb, async (writes) => {
    const [policy] = await sourceDb.select().from(federationPolicies);
    writes.push(
      sourceDb
        .update(federationPolicies)
        .set({ sendQuestions: false })
        .where(eq(federationPolicies.id, policy.id)),
    );
  });
  await expect(sync()).rejects.toThrow('FEDERATION_PEER_UNAVAILABLE');
  await expect(
    loadMatchDefinition(host, { owner: hostOwner, profile: 'local' }),
  ).rejects.toThrow('NO_RANKED_QUESTIONS');
  expect(
    (
      await hostDb
        .select()
        .from(federationQuestionImports)
        .where(eq(federationQuestionImports.id, importId))
    )[0].errorCode,
  ).toBe('FEDERATION_PEER_UNAVAILABLE');
});

it('同じ組織内も明示許可を必要とし、元カテゴリの停止を次の試合へ即時反映する', async () => {
  const localId = crypto.randomUUID(),
    categoryId = crypto.randomUUID(),
    localImport = crypto.randomUUID();
  await addInstance(hostDb, 'host-admin', { id: localId, name: '組織内共有元' });
  const [instance] = await hostDb
    .select()
    .from(instances)
    .where(eq(instances.id, localId));
  const { account } = await organizationIdentity(hostDb, 'host-admin');
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .update(instances)
        .set({ state: 'published' })
        .where(eq(instances.id, localId)),
      hostDb
        .insert(questionCategories)
        .values({ id: categoryId, instanceId: localId, name: '組織内' }),
    );
    const plan = new QuestionPlan(localId, instance.owner);
    await plan.load(hostDb, { operation: 'seed' });
    const row = plan.draft(
      account.actorId,
      '管理者',
      {
        ...emptyQuestion(),
        text: '組織内問題',
        explanation: '解説',
        source: '独自作成',
        displayAnswer: 'あ',
        readings: ['あ'],
        categoryId,
        evidence: '独自作成',
      },
      { status: 'approved' },
    );
    plan.save(row, { publishedId: await plan.publish(row) });
    plan.flush(writes);
  });
  await questionSharing(host, 'host-admin', {
    operation: 'internalPermission',
    instanceId: hostId,
    sourceInstanceId: localId,
    allowed: true,
  });

  await configure({ id: localImport, peerOrigin: hostOrigin, sourceInstanceId: localId });
  for (let i = 0; i < 4; i++)
    if (!(await syncQuestionImport(host, localImport)).pending) break;
  const definition = await loadMatchDefinition(host, {
    owner: hostOwner,
    profile: 'local-casual',
  });
  expect(definition.questions).toHaveLength(1);
  await questionSharing(host, 'host-admin', {
    operation: 'internalPermission',
    instanceId: hostId,
    sourceInstanceId: localId,
    allowed: false,
  });
  await expect(
    loadMatchDefinition(host, { owner: hostOwner, profile: 'local' }),
  ).rejects.toThrow('NO_RANKED_QUESTIONS');
  expect(definition.questions).toHaveLength(1);
});

it('30日間未使用の共有本文だけを消去し、除外IDと過去版の参照を保持して再取得できる', async () => {
  const old = Date.now() - 31 * 86400000;
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .update(federationQuestionImports)
        .set({ lastSuccessAt: old, activeSnapshot: null }),
      hostDb.update(federationQuestionLinks).set({ lastAvailableAt: old }),
    );
  });
  expect(await expireSharedQuestions(hostDb)).toBe(25);
  expect(await expireSharedQuestions(hostDb)).toBe(3);
  const [excluded] = await hostDb
    .select()
    .from(federationQuestionLinks)
    .where(eq(federationQuestionLinks.excluded, true));
  expect(excluded.cachePurgedAt).not.toBeNull();
  const [row] = await hostDb
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.id, excluded.submissionId));
  const [version] = await hostDb
    .select()
    .from(questionVersions)
    .where(eq(questionVersions.questionId, row.publishedId as string));
  expect(version.payload.text).toBeUndefined();
  expect(row.input.readings).toEqual([]);
  await expect(
    questionMutation(
      hostDb,
      'host-admin',
      hostId,
      {
        operation: 'difficulty',
        changes: [{ id: row.id, revision: row.revision, difficulty: 2, fixed: true }],
        reason: '期限切れの補正',
      },
      'local',
    ),
  ).rejects.toThrow('SHARED_QUESTION_EXPIRED');
  await expect(
    changeD1(hostDb, async (writes) => {
      writes.push(
        hostDb
          .update(questionVersions)
          .set({ payload: { ...version.payload, text: '改竄' } })
          .where(eq(questionVersions.questionId, version.questionId)),
      );
    }),
  ).rejects.toThrow('IMMUTABLE_CATALOG');
  await changeD1(sourceDb, async (writes) => {
    const [policy] = await sourceDb.select().from(federationPolicies);
    writes.push(
      sourceDb
        .update(federationPolicies)
        .set({ sendQuestions: true })
        .where(eq(federationPolicies.id, policy.id)),
    );
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    app.request(input as Request, undefined, source),
  );
  await complete();
  const [restored] = await hostDb
    .select()
    .from(federationQuestionLinks)
    .where(eq(federationQuestionLinks.submissionId, excluded.submissionId));
  expect(restored.excluded).toBe(true);
  expect(restored.cachePurgedAt).toBeNull();
  expect(
    (
      await loadMatchDefinition(host, {
        owner: hostOwner,
        profile: 'local-casual',
      })
    ).questions,
  ).toHaveLength(26);
});

it('複数の共有元を取り込み専用カテゴリへ集約し、通常投稿とJSON取込を拒否する', async () => {
  const targetId = crypto.randomUUID(),
    targetCategory = crypto.randomUUID(),
    jobId = crypto.randomUUID();
  await addInstance(hostDb, 'host-admin', { id: targetId, name: '取り込み専用の検証先' });
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb.insert(federationPolicies).values({
        id: crypto.randomUUID(),
        instanceId: targetId,
        peerOrigin: sourceOrigin,
        peerInstanceId: sourceId,
        receiveQuestions: true,
      }),
    );
  });
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb.insert(federationPolicies).values({
        id: crypto.randomUUID(),
        instanceId: sourceId,
        peerOrigin: hostOrigin,
        peerInstanceId: targetId,
        sendQuestions: true,
      }),
    );
  });
  const config = {
    categories: [],
    targetCategoryId: targetCategory,
    difficulty: { '0': 0, '1': 1, '2': 2 },
    fallback: 0,
  };
  await questionSharing(host, 'host-admin', {
    operation: 'import',
    instanceId: targetId,
    id: jobId,
    revision: 0,
    peerOrigin: sourceOrigin,
    sourceInstanceId: sourceId,
    config,
    enabled: true,
    newCategoryName: '外部問題',
    newCategoryImportOnly: true,
  });
  expect(
    (
      await hostDb
        .select()
        .from(questionCategories)
        .where(eq(questionCategories.id, targetCategory))
    )[0].importOnly,
  ).toBe(true);
  const input = {
    ...emptyQuestion(),
    categoryId: targetCategory,
    text: '通常投稿',
    displayAnswer: 'あ',
    readings: ['あ'],
    evidence: '独自作成',
  };
  await expect(
    questionMutation(hostDb, 'host-admin', targetId, { operation: 'save', input }),
  ).rejects.toThrow('CATEGORY_IMPORT_ONLY');
  await expect(
    questionMutation(hostDb, 'host-admin', targetId, {
      operation: 'import',
      requestId: crypto.randomUUID(),
      questions: [input],
    }),
  ).rejects.toThrow('CATEGORY_IMPORT_ONLY');
  const [localSource] = await hostDb
    .select()
    .from(instances)
    .where(sql`${instances.id}<>${hostId} and ${instances.id}<>${targetId}`);
  await questionSharing(host, 'host-admin', {
    operation: 'internalPermission',
    instanceId: targetId,
    sourceInstanceId: localSource.id,
    allowed: true,
  });
  const localJob = crypto.randomUUID();
  await questionSharing(host, 'host-admin', {
    operation: 'import',
    instanceId: targetId,
    id: localJob,
    revision: 0,
    peerOrigin: hostOrigin,
    sourceInstanceId: localSource.id,
    config,
    enabled: true,
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) =>
    app.request(request as Request, undefined, source),
  );
  for (const id of [jobId, localJob])
    for (let step = 0; step < 10; step++)
      if (!(await syncQuestionImport(host, id)).pending) break;
  const list = {
    scope: 'all',
    page: 1,
    pageSize: 100,
    query: '',
    status: '',
    category: '',
    shared: 'shared',
  };
  const overview = await questionOverview(hostDb, 'host-admin', targetId, list);
  expect(overview.submissions).toHaveLength(28);
  expect(overview.sharedSources).toHaveLength(2);
  expect(
    overview.submissions.every((row) => row.input.categoryId === targetCategory),
  ).toBe(true);
  const [row] = overview.submissions;
  await questionMutation(hostDb, 'host-admin', targetId, {
    operation: 'bulk',
    action: 'exclude-shared',
    requestId: crypto.randomUUID(),
    reason: '重複',
    changes: [{ id: row.id, revision: row.revision, excluded: true }],
  });
  const excluded = await questionOverview(hostDb, 'host-admin', targetId, {
    ...list,
    shared: 'excluded',
  });
  expect(excluded.submissions).toHaveLength(1);
  expect(excluded.submissions[0].shared?.excluded).toBe(true);
  const sourceCategoryRows = await questionOverview(hostDb, 'host-admin', targetId, {
    ...list,
    peerOrigin: sourceOrigin,
    sourceInstanceId: sourceId,
    sourceCategory,
  });
  expect(sourceCategoryRows.submissions).toHaveLength(27);
  const changedCategoryRow = sourceCategoryRows.submissions[0];
  await changeD1(hostDb, async (writes) => {
    writes.push(
      hostDb
        .update(federationQuestionLinks)
        .set({
          sourceCategory: { id: sourceCategory, name: '更新中のカテゴリ名' },
          lastAvailableAt: Date.now() + 1,
        })
        .where(eq(federationQuestionLinks.submissionId, changedCategoryRow.id)),
    );
  });
  const renamedList = await questionOverview(hostDb, 'host-admin', targetId, list);
  expect(
    renamedList.sharedSourceCategories?.filter(
      (category) =>
        category.peerOrigin === sourceOrigin && category.id === sourceCategory,
    ),
  ).toEqual([
    {
      peerOrigin: sourceOrigin,
      instanceId: sourceId,
      id: sourceCategory,
      name: '更新中のカテゴリ名',
    },
  ]);
  const rowAfterExclusion = excluded.submissions[0];
  await questionMutation(hostDb, 'host-admin', targetId, {
    operation: 'exclude-shared',
    id: rowAfterExclusion.id,
    revision: rowAfterExclusion.revision,
    excluded: false,
  });
  expect(
    (
      await questionOverview(hostDb, 'host-admin', targetId, {
        ...list,
        shared: 'excluded',
      })
    ).submissions,
  ).toEqual([]);
  const local = await questionOverview(hostDb, 'host-admin', targetId, {
    ...list,
    shared: 'local',
  });
  expect(local.submissions).toEqual([]);
  const emptyCategory = crypto.randomUUID();
  await changeD1(sourceDb, async (writes) => {
    writes.push(
      sourceDb
        .insert(questionCategories)
        .values({ id: emptyCategory, instanceId: sourceId, name: '問題がないカテゴリ' }),
      sourceDb
        .update(questionCategories)
        .set({ name: '最新のカテゴリ名' })
        .where(eq(questionCategories.id, sourceCategory)),
    );
  });
  const scope = {
    instanceId: targetId,
    peerOrigin: sourceOrigin,
    sourceInstanceId: sourceId,
  };
  await cachedQuestionSource(hostDb, scope);
  await refreshQuestionSource(host, scope);
  const readSharing = async () =>
    (await questionSharing(host, 'host-admin', {
      operation: 'overview',
      instanceId: targetId,
    })) as QuestionSharingOverview;
  const named = await readSharing();
  expect(named.sourceCategories).toEqual(
    expect.arrayContaining([
      {
        peerOrigin: sourceOrigin,
        sourceInstanceId: sourceId,
        id: emptyCategory,
        name: '問題がないカテゴリ',
      },
      {
        peerOrigin: sourceOrigin,
        sourceInstanceId: sourceId,
        id: sourceCategory,
        name: '最新のカテゴリ名',
      },
    ]),
  );
  expect(
    named.sourceCategories.filter(
      (category) =>
        category.peerOrigin === sourceOrigin && category.id === sourceCategory,
    ),
  ).toHaveLength(1);
  const reconfigure = (revision: number, categories: string[]) =>
    questionSharing(host, 'host-admin', {
      operation: 'import',
      instanceId: targetId,
      id: jobId,
      revision,
      peerOrigin: sourceOrigin,
      sourceInstanceId: sourceId,
      config: { ...config, categories },
      enabled: true,
    });
  const finishUpdated = async () => {
    for (let step = 0; step < 10; step++)
      if (!(await syncQuestionImport(host, jobId)).pending) return;
    throw new Error('SYNC_DID_NOT_COMPLETE');
  };
  await reconfigure(1, [emptyCategory]);
  expect((await readSharing()).imports.find((job) => job.id === jobId)?.syncing).toBe(
    true,
  );
  await finishUpdated();
  expect((await readSharing()).imports.find((job) => job.id === jobId)?.syncing).toBe(
    false,
  );
  await reconfigure(2, []);
  expect((await readSharing()).imports.find((job) => job.id === jobId)).toMatchObject({
    syncing: true,
    lastSuccessAt: expect.any(Number),
  });
  await finishUpdated();
  expect((await readSharing()).imports.find((job) => job.id === jobId)?.syncing).toBe(
    false,
  );
});
