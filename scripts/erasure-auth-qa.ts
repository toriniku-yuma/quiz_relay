import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { API_PATHS } from '../src/shared/api-paths.ts';
import { emptyQuestion } from '../src/shared/questions.ts';
import {
  instanceGrants,
  instances,
  organizationAccounts,
  questionSubmissions,
} from '../src/worker/db/schema.ts';

export function liveAuthConfiguration() {
  const runtime = parseEnv(readFileSync('.dev.vars', 'utf8'));
  const local = parseEnv(readFileSync('.env.erasure-local', 'utf8'));
  if (
    !runtime.SUPABASE_URL ||
    runtime.SUPABASE_URL !== local.SUPABASE_URL ||
    !runtime.SUPABASE_PUBLISHABLE_KEY ||
    !local.SUPABASE_SECRET_KEY
  )
    throw new Error('LIVE_AUTH_CONFIGURATION_REQUIRED');
  return {
    url: runtime.SUPABASE_URL,
    publicKey: runtime.SUPABASE_PUBLISHABLE_KEY,
    secretKey: local.SUPABASE_SECRET_KEY,
  };
}

// Fresh identities only; this never signs in, deletes, or modifies an existing user.
export async function verifyLiveAuth(
  db: PostgresJsDatabase,
  post: (
    path: string,
    body: object,
    token?: string,
  ) => Promise<{ status: number; body: Record<string, unknown> }>,
) {
  const config = liveAuthConfiguration();
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
    },
  };
  const admin = createClient(config.url, config.secretKey, options);
  const client = createClient(config.url, config.publicKey, options);
  const email = `quiz-relay-erasure-${crypto.randomUUID()}@example.com`;
  const created = new Set<string>();
  let cleanupIncomplete = false;
  async function register() {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { erasure_test: true },
    });
    if (error || !data.user) throw new Error('LIVE_AUTH_CREATE_FAILED');
    created.add(data.user.id);
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (link.error || !link.data.properties.hashed_token)
      throw new Error('LIVE_AUTH_LINK_FAILED');
    const verified = await client.auth.verifyOtp({
      type: 'email',
      token_hash: link.data.properties.hashed_token,
    });
    if (verified.error || !verified.data.session)
      throw new Error('LIVE_AUTH_SIGN_IN_FAILED');
    assert.equal(verified.data.session.user.id, data.user.id);
    return { id: data.user.id, token: verified.data.session.access_token };
  }
  try {
    const first = await register();
    const initial = await post(API_PATHS.organizationOverview, {}, first.token);
    assert.equal(initial.status, 200);
    const actorId = (initial.body.account as { actorId: string }).actorId;
    const [instance] = await db.select().from(instances).limit(1);
    assert(instance);
    await db
      .update(organizationAccounts)
      .set({ administrator: true, displayName: '実認証の消去検証' })
      .where(eq(organizationAccounts.actorId, actorId));
    await db
      .insert(instanceGrants)
      .values({ instanceId: instance.id, actorId, permission: 'questions' });
    const questionId = crypto.randomUUID();
    await db.insert(questionSubmissions).values({
      id: questionId,
      seriesId: questionId,
      instanceId: instance.id,
      authorId: actorId,
      authorName: '実認証の消去検証',
      input: { ...emptyQuestion(), text: '再登録しても旧投稿の所有権は引き継がない' },
    });
    const operationId = crypto.randomUUID();
    assert.equal(
      (
        await post(
          API_PATHS.accountWithdrawal,
          { subject: first.id, operationId, confirmation: '退会' },
          first.token,
        )
      ).status,
      200,
    );
    assert.deepEqual((await post(API_PATHS.withdrawalStatus, { operationId })).body, {
      accepted: true,
      ready: true,
    });
    assert.equal(
      (await post(API_PATHS.organizationOverview, {}, first.token)).status,
      401,
    );
    const old = await admin.auth.admin.getUserById(first.id);
    assert.equal(old.data.user, null);
    const second = await register();
    assert.notEqual(second.id, first.id);
    const fresh = await post(API_PATHS.organizationOverview, {}, second.token);
    assert.equal(fresh.status, 200);
    const account = fresh.body.account as {
      actorId: string;
      administrator: boolean;
      displayName: string | null;
    };
    assert.notEqual(account.actorId, actorId);
    assert.equal(account.administrator, false);
    assert.equal(account.displayName, null);
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
    const [retained] = await db
      .select()
      .from(questionSubmissions)
      .where(eq(questionSubmissions.id, questionId));
    assert.equal(retained.authorId, actorId);
    assert.equal(retained.authorName, '退会ユーザー');
    console.log(
      'PASS: real Supabase email authentication, Auth deletion and old-token denial, same-email fresh registration, no inherited privileges or ownership',
    );
  } finally {
    for (const id of created) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error && error.code !== 'user_not_found') cleanupIncomplete = true;
    }
    if (cleanupIncomplete) console.error('LIVE_AUTH_CLEANUP_INCOMPLETE');
  }
  if (cleanupIncomplete) throw new Error('LIVE_AUTH_CLEANUP_INCOMPLETE');
}
