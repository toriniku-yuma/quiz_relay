import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';
import { API_PATHS } from '../src/shared/api-paths.ts';
import { emptyQuestion } from '../src/shared/questions.ts';
import {
  accountWithdrawals,
  instanceDeletions,
  instanceGrants,
  instanceRooms,
  instances,
  organizationAccounts,
  questionSubmissions,
} from '../src/worker/db/schema.ts';
import type { State } from '../src/worker/game/state.ts';
import { organizationIdentity } from '../src/worker/organization/database.ts';

// Actual local service binding, DO RPC, API handlers, and restricted DB roles.
// Auth defaults to a disposable loopback stub; OPERATIONS_AUTH_QA also checks fresh real Auth users.
export async function verifyErasureService(
  db: PostgresJsDatabase,
  address: string,
  directory: string,
  organizationId: string,
) {
  const target = new URL(address);
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.port, '55439');
  assert.equal(target.pathname, '/quiz_relay_questions_test');
  const password = Buffer.from(randomBytes(24)).toString('hex');
  // DDL only in the fresh isolated cluster; password contains hexadecimal characters only.
  for (const role of ['quiz_organization', 'quiz_erasure'])
    await db.execute(sql.raw(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`));
  const roleAddress = (role: string) => {
    const url = new URL(address);
    url.username = role;
    url.password = password;
    return url.toString();
  };
  const subject = crypto.randomUUID(),
    replacement = crypto.randomUUID();
  const identity = await organizationIdentity(db, subject);
  await db
    .update(organizationAccounts)
    .set({ displayName: '消去サービス検証', administrator: false })
    .where(eq(organizationAccounts.actorId, identity.account.actorId));
  const instanceId = crypto.randomUUID(),
    owner = `urn:uuid:${instanceId}`;
  await db.insert(instances).values({
    id: instanceId,
    owner,
    organizationId,
    name: '消去サービス検証',
    state: 'published',
    roomInventoryComplete: true,
  });
  // These scopes have no legacy DOs: this test just created a fresh Worker/DO namespace.
  await db.update(instances).set({ roomInventoryComplete: true });
  await db
    .insert(instanceGrants)
    .values({ instanceId, actorId: identity.account.actorId, permission: 'questions' });
  const questionId = crypto.randomUUID();
  await db.insert(questionSubmissions).values({
    id: questionId,
    seriesId: questionId,
    instanceId,
    authorId: identity.account.actorId,
    authorName: '消去サービス検証',
    input: { ...emptyQuestion(), text: '保持する検証問題' },
  });

  let failing = true,
    deleted = false;
  const users = new Map([
    ['author-token', subject],
    ['administrator-token', 'outsider'],
  ]);
  const auth = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const send = (status: number, value: unknown) => {
      response.statusCode = status;
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && request.url === '/auth/v1/user') {
      const id = users.get((request.headers.authorization ?? '').replace('Bearer ', ''));
      if (!id) return send(401, { code: 'bad_jwt', msg: 'Invalid test identity' });
      return send(200, {
        id,
        email: 'erasure-test@example.invalid',
        email_confirmed_at: new Date().toISOString(),
        user_metadata: {},
      });
    }
    if (
      request.method === 'DELETE' &&
      request.url === `/auth/v1/admin/users/${subject}`
    ) {
      if (failing)
        return send(503, { code: 'unexpected_failure', msg: 'Temporary test outage' });
      deleted = true;
      users.delete('author-token');
      return send(200, { id: subject });
    }
    return send(404, { code: 'not_found' });
  });
  let app: Unstable_DevWorker | undefined, erasure: Unstable_DevWorker | undefined;
  try {
    await new Promise<void>((resolveReady) => auth.listen(0, '127.0.0.1', resolveReady));
    const authAddress = auth.address();
    assert(authAddress && typeof authAddress !== 'string');
    const authUrl = `http://127.0.0.1:${authAddress.port}`;
    const suffix = Buffer.from(randomBytes(6)).toString('hex');
    const appName = `operations-qa-${suffix}`,
      erasureName = `erasure-qa-${suffix}`;
    const common = {
      compatibility_date: '2026-09-08',
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      preview_urls: false,
    };
    const appConfig = resolve(directory, 'app.json'),
      erasureConfig = resolve(directory, 'erasure.json');
    const fixtureEntry = resolve(directory, 'fixture-worker.ts');
    // Test-only fixture access, generated inside the disposable directory and never deployed.
    writeFileSync(
      fixtureEntry,
      `
import app, { GameRoom, Matchmaker } from ${JSON.stringify(resolve('src/worker/index.ts').replaceAll('\\', '/'))};
import { resultFixture } from ${JSON.stringify(resolve('tests/fixtures/result.ts').replaceAll('\\', '/'))};
export { Matchmaker };
export class ErasureTestRoom extends GameRoom {
  async fixture(room) {
    if (room) await this.ctx.storage.put('room', room);
    return {
      id: this.ctx.id.toString(),
      room: await this.ctx.storage.get('room'),
      deleted: await this.ctx.storage.get('instanceDeleted'),
    };
  }
}
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/qa/room') {
      const input = await request.json();
      let room = input.room;
      if (input.initialize) {
        const { state } = resultFixture();
        state.result.storage = 'confirmed';
        state.result.finishedAt = Date.now();
        for (const players of [state.players, state.completed.players]) {
          players[0].id = input.actorId;
          players[0].name = '消去サービス検証';
        }
        state.question.id = input.questionId;
        state.question.authorName = '消去サービス検証';
        room = { scope: input.scope, state, sessions: {} };
      }
      return Response.json(await env.GAME_ROOM.getByName('erasure-fixture').fixture(room));
    }
    return app.fetch(request, env, ctx);
  }
};
`,
    );
    writeFileSync(
      appConfig,
      JSON.stringify({
        ...common,
        name: appName,
        main: fixtureEntry,
        durable_objects: {
          bindings: [
            { name: 'GAME_ROOM', class_name: 'ErasureTestRoom' },
            { name: 'MATCHMAKER', class_name: 'Matchmaker' },
          ],
        },
        migrations: [
          { tag: 'v1', new_sqlite_classes: ['ErasureTestRoom', 'Matchmaker'] },
        ],
        services: [{ binding: 'ACCOUNT_ERASURE', service: erasureName }],
        vars: {
          ORGANIZATION_ENABLED: 'true',
          ORGANIZATION_DATABASE_URL: roleAddress('quiz_organization'),
          GAME_OWNER: owner,
          GAME_CONFIG_PROFILE: 'default',
          SUPABASE_URL: authUrl,
          SUPABASE_PUBLISHABLE_KEY: 'test-key',
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      erasureConfig,
      JSON.stringify({
        ...common,
        name: erasureName,
        main: resolve('src/erasure/index.ts'),
        routes: [],
        durable_objects: {
          bindings: [
            { name: 'GAME_ROOM', class_name: 'ErasureTestRoom', script_name: appName },
            { name: 'MATCHMAKER', class_name: 'Matchmaker', script_name: appName },
          ],
        },
        vars: {
          ERASURE_DATABASE_URL: roleAddress('quiz_erasure'),
          SUPABASE_URL: authUrl,
          SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
        },
      }),
      { mode: 0o600 },
    );
    const options = {
      local: true,
      ip: '127.0.0.1',
      port: 0,
      inspectorPort: 0,
      envFiles: [],
      persist: false,
      logLevel: 'none' as const,
      experimental: { watch: false, showInteractiveDevSession: false },
    };
    app = await unstable_dev(fixtureEntry, {
      ...options,
      config: appConfig,
    });
    erasure = await unstable_dev(resolve('src/erasure/index.ts'), {
      ...options,
      config: erasureConfig,
    });
    const origin = `http://127.0.0.1:${app.port}`;
    const post = async (path: string, body: object, token?: string) => {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    const operationId = crypto.randomUUID();
    const fixture = await post('/qa/room', {
      initialize: true,
      actorId: identity.account.actorId,
      questionId,
      scope: { id: instanceId, owner },
    });
    const room = fixture.body.room as {
      scope: { id: string; owner: string };
      state: State;
      sessions: Record<string, string>;
    };
    const { state } = room;
    assert(state.result && state.completed);
    await db
      .insert(instanceRooms)
      .values({ instanceId, roomId: fixture.body.id as string });
    const initialCounters = (await (
      await erasure.fetch('/status', { method: 'POST' })
    ).json()) as {
      pendingAuthentication: number;
      pendingAnonymization: number;
      oldestWithdrawalRequestedAt: string | null;
    };
    assert.equal(
      (
        await post(
          API_PATHS.accountWithdrawal,
          { operationId, subject, confirmation: '退会' },
          'author-token',
        )
      ).status,
      200,
    );
    assert.deepEqual((await post(API_PATHS.withdrawalStatus, { operationId })).body, {
      accepted: true,
      ready: false,
    });
    assert.equal(
      (await post(API_PATHS.organizationOverview, {}, 'author-token')).body.code,
      'ACCOUNT_WITHDRAWN',
    );
    assert.equal(deleted, false);
    const pendingStatus = await erasure.fetch('/status', { method: 'POST' });
    assert.equal(pendingStatus.status, 200);
    const counters = (await pendingStatus.json()) as Record<string, unknown>;
    assert.equal(
      counters.pendingAuthentication,
      initialCounters.pendingAuthentication + 1,
    );
    assert.equal(counters.pendingAnonymization, initialCounters.pendingAnonymization + 1);
    assert.equal(counters.overdueWithdrawals, 0);
    assert.equal(counters.pendingInstanceDeletion, 0);
    assert.equal(counters.unreconciledInstances, 0);
    assert.equal(typeof counters.oldestWithdrawalRequestedAt, 'string');
    const overdueAt = new Date(Date.now() - 31 * 86400000).toISOString();
    await db
      .update(accountWithdrawals)
      .set({ requestedAt: overdueAt })
      .where(eq(accountWithdrawals.id, operationId));
    assert.equal(
      (
        (await (await erasure.fetch('/status', { method: 'POST' })).json()) as Record<
          string,
          unknown
        >
      ).overdueWithdrawals,
      1,
    );
    const anonymized = (await post('/qa/room', {})).body.room as typeof room;
    assert.equal(anonymized.state.players[0].name, '退会ユーザー');
    assert.equal(anonymized.state.players[1].name, state.players[1].name);
    assert.deepEqual(anonymized.state.result, state.result);
    assert.equal(anonymized.state.question.authorName, '退会ユーザー');
    failing = false;
    await db
      .update(accountWithdrawals)
      .set({ retryAt: new Date().toISOString() })
      .where(eq(accountWithdrawals.id, operationId));
    const maintenance = await erasure.fetch('/maintenance', { method: 'POST' });
    assert.equal(maintenance.status, 200);
    assert(deleted);
    assert.deepEqual((await post(API_PATHS.withdrawalStatus, { operationId })).body, {
      accepted: true,
      ready: true,
    });
    let [job] = await db
      .select()
      .from(accountWithdrawals)
      .where(eq(accountWithdrawals.id, operationId));
    // Each maintenance call handles a bounded number of accounts; earlier jobs also rotate.
    for (let attempt = 0; !job.erasedAt && attempt < 10; attempt++) {
      assert.equal((await erasure.fetch('/maintenance', { method: 'POST' })).status, 200);
      [job] = await db
        .select()
        .from(accountWithdrawals)
        .where(eq(accountWithdrawals.id, operationId));
    }
    assert(job.authDeletedAt && job.erasedAt);
    const finishedStatus = (await (
      await erasure.fetch('/status', { method: 'POST' })
    ).json()) as Record<string, unknown>;
    // Recovery QA leaves a different Auth job pending; completing this account must not hide it.
    assert.equal(
      finishedStatus.pendingAuthentication,
      initialCounters.pendingAuthentication,
    );
    assert.equal(
      finishedStatus.pendingAnonymization,
      initialCounters.pendingAnonymization,
    );
    assert.equal(finishedStatus.overdueWithdrawals, 0);
    assert.equal(
      finishedStatus.oldestWithdrawalRequestedAt,
      initialCounters.oldestWithdrawalRequestedAt,
    );
    const [question] = await db
      .select()
      .from(questionSubmissions)
      .where(eq(questionSubmissions.id, questionId));
    assert.equal(question.authorName, '退会ユーザー');
    assert.equal(question.input.text, '保持する検証問題');
    users.set('replacement-token', replacement);
    const overview = await post(API_PATHS.organizationOverview, {}, 'replacement-token');
    assert.equal(overview.status, 200);
    const account = overview.body.account as {
      actorId: string;
      displayName: string | null;
      administrator: boolean;
    };
    assert.notEqual(account.actorId, identity.account.actorId);
    assert.equal(account.displayName, null);
    assert.equal(account.administrator, false);
    assert.equal(
      (
        await db
          .select()
          .from(instanceGrants)
          .where(eq(instanceGrants.actorId, account.actorId))
      ).length,
      0,
    );
    assert.equal(
      (
        await db
          .select()
          .from(questionSubmissions)
          .where(eq(questionSubmissions.authorId, account.actorId))
      ).length,
      0,
    );
    await db
      .update(instances)
      .set({ state: 'archived' })
      .where(eq(instances.id, instanceId));
    const deletionId = crypto.randomUUID();
    const deleteInput = {
      id: instanceId,
      name: '消去サービス検証',
      revision: 0,
      operationId: deletionId,
    };
    room.state.phase = 'REVEALING';
    await post('/qa/room', { room });
    assert.equal(
      (await post(API_PATHS.instanceDeletion, deleteInput, 'administrator-token')).body
        .code,
      'RESULT_OR_MATCH_PENDING',
    );
    room.state.phase = 'FINISHED';
    state.result.storage = 'pending';
    await post('/qa/room', { room });
    assert.equal(
      (await post(API_PATHS.instanceDeletion, deleteInput, 'administrator-token')).body
        .code,
      'RESULT_OR_MATCH_PENDING',
    );
    assert.equal(
      (
        await db
          .select()
          .from(instanceDeletions)
          .where(eq(instanceDeletions.id, deletionId))
      ).length,
      0,
    );
    state.result.storage = 'confirmed';
    await post('/qa/room', { room });
    assert.equal(
      (await post(API_PATHS.instanceDeletion, deleteInput, 'administrator-token')).status,
      200,
    );
    assert.equal(
      (await post(API_PATHS.instanceDeletion, deleteInput, 'administrator-token')).status,
      200,
    );
    assert.equal(
      (await db.select().from(instances).where(eq(instances.id, instanceId))).length,
      0,
    );
    assert(
      (
        await db
          .select()
          .from(instanceDeletions)
          .where(eq(instanceDeletions.id, deletionId))
      )[0].deletedAt,
    );
    const erasedRoom = (await post('/qa/room', {})).body;
    assert.equal(erasedRoom.room, undefined);
    assert.equal(erasedRoom.deleted, instanceId);
    assert.equal(
      (
        await db
          .select()
          .from(organizationAccounts)
          .where(
            and(
              eq(organizationAccounts.actorId, account.actorId),
              eq(organizationAccounts.organizationId, organizationId),
            ),
          )
      ).length,
      1,
    );
    console.log(
      'PASS: actual local service binding and native GameRoom/Matchmaker RPC, restricted DB connections, Auth outage/retry, immediate withdrawal denial, stored room anonymization, fresh identity without ownership/grants, active/unsaved deletion guards, stored room erasure and deletion replay',
    );
    if (process.env.OPERATIONS_AUTH_QA === '1') {
      const { liveAuthConfiguration, verifyLiveAuth } = await import(
        './erasure-auth-qa.ts'
      );
      const live = liveAuthConfiguration();
      await erasure.stop();
      await app.stop();
      const appSettings = JSON.parse(readFileSync(appConfig, 'utf8'));
      appSettings.vars.SUPABASE_URL = live.url;
      appSettings.vars.SUPABASE_PUBLISHABLE_KEY = live.publicKey;
      writeFileSync(appConfig, JSON.stringify(appSettings), { mode: 0o600 });
      const erasureSettings = JSON.parse(readFileSync(erasureConfig, 'utf8'));
      erasureSettings.vars.SUPABASE_URL = live.url;
      delete erasureSettings.vars.SUPABASE_SERVICE_ROLE_KEY;
      erasureSettings.vars.SUPABASE_SECRET_KEY = live.secretKey;
      writeFileSync(erasureConfig, JSON.stringify(erasureSettings), { mode: 0o600 });
      app = await unstable_dev(fixtureEntry, {
        ...options,
        port: app.port,
        config: appConfig,
      });
      erasure = await unstable_dev(resolve('src/erasure/index.ts'), {
        ...options,
        config: erasureConfig,
      });
      await verifyLiveAuth(db, post);
    }
  } finally {
    await erasure?.stop();
    await app?.stop();
    await new Promise<void>((done) => auth.close(() => done()));
  }
}
