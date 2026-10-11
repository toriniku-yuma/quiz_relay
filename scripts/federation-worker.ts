import { count, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { importPKCS8, importSPKI } from 'jose';
import { API_PATHS } from '../src/shared/api-paths';
import {
  type AuthEnv,
  authenticate,
  authIdentity,
  publicAuthConfig,
} from '../src/worker/auth/handlers';
import { connectD1 } from '../src/worker/db/d1';
import { instances, organizations, probeRuns } from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { peerRequest, rejectRedirect } from '../src/worker/federation/egress';
import {
  bodyHash,
  DELIVERY_TTL,
  type Delivery,
  INBOX_PATH,
  signDelivery,
  verifyDelivery,
} from '../src/worker/federation/signatures';
import { addInstance, setupOrganization } from '../src/worker/organization/database';
import { authorizeProbe } from '../src/worker/probes/authorize';

// Separate entry point: never mount this test inbox or fault controls in the game Worker.
export interface FederationTestEnv extends Env {
  GAME_D1: D1Database;
  TEST_NODE: string;
  PEER_ORIGIN: string;
  SIGNING_KID: string;
  SIGNING_PRIVATE_KEY: string;
  PEER_KID: string;
  PEER_PUBLIC_KEY: string;
  TEST_ADMIN_SUBJECT?: string;
}
const app = new Hono<{
  Bindings: FederationTestEnv;
  Variables: AuthEnv['Variables'];
}>();
const faults = ['normal', 'unavailable', 'redirect', 'timeout'] as const;
const faultIds = faults.map((mode) => `fault:${mode}`);

app.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  if (
    context.req.path !== API_PATHS.health &&
    context.env.API_LIMITER &&
    !(
      await context.env.API_LIMITER.limit({
        key: `test:${context.req.header('CF-Connecting-IP') ?? 'local'}`,
      })
    ).success
  )
    return context.json({ code: 'RATE_LIMIT' }, 429);
  await next();
});
app.use('*', bodyLimit({ maxSize: 16 * 1024 }));
app.get(API_PATHS.health, (context) =>
  context.json({
    ok: true,
    environment: 'federation-test',
    node: context.env.TEST_NODE,
    gameReady: false,
  }),
);
app.get(API_PATHS.authConfig, publicAuthConfig);
app.get(API_PATHS.authIdentity, authenticate, authIdentity);

app.use('/api/probes/*', authorizeProbe);
app.get('/api/probes/status', async (context) => {
  const db = connectD1(context.env.GAME_D1);
  const [result] = await db.select({ rows: count() }).from(probeRuns);
  const [organization] = await db.select({ rows: count() }).from(organizations);
  const [instance] = await db.select({ rows: count() }).from(instances);
  return context.json({
    node: context.env.TEST_NODE,
    d1: true,
    probeRows: result.rows,
    organizations: organization.rows,
    instances: instance.rows,
  });
});
app.post('/api/probes/database/setup', async (context) => {
  const env = context.env;
  const subject = env.TEST_ADMIN_SUBJECT;
  if (!subject || !['A', 'B'].includes(env.TEST_NODE))
    return context.json({ code: 'SETUP_NOT_CONFIGURED' }, 503);
  const db = connectD1(env.GAME_D1);
  const name = `連携検証 ${env.TEST_NODE}`;
  const [existing] = await db.select().from(organizations);
  if (existing && existing.name !== name)
    return context.json({ code: 'DATABASE_TARGET_MISMATCH' }, 409);
  if (!existing)
    await setupOrganization(db, { ...env, INITIAL_ADMIN_SUBJECT: subject }, subject, {
      name,
      instanceName: `${env.TEST_NODE}-1`,
    });
  await addInstance(db, subject, {
    id:
      env.TEST_NODE === 'A'
        ? '4ed56d67-fd75-4d02-8f0a-64966df2e897'
        : 'c3565842-e625-43fb-8437-243425424314',
    name: `${env.TEST_NODE}-2`,
  });
  const [organization] = await db.select({ rows: count() }).from(organizations);
  const [instance] = await db.select({ rows: count() }).from(instances);
  return context.json({
    node: env.TEST_NODE,
    organizations: organization.rows,
    instances: instance.rows,
    gameReady: false,
  });
});
app.post('/api/probes/fault', async (context) => {
  const input = await context.req.json<{ mode?: unknown }>();
  const mode = faults.find((value) => value === input.mode);
  if (!mode) return context.json({ code: 'INVALID_FAULT' }, 400);
  const db = connectD1(context.env.GAME_D1);
  await db.batch([
    db.delete(probeRuns).where(inArray(probeRuns.id, faultIds)),
    db.insert(probeRuns).values({ id: `fault:${mode}` }),
  ]);
  return context.json({ mode });
});
app.post('/api/probes/run', async (context) => {
  const env = context.env;
  const body = { check: 'external-workers-d1', node: env.TEST_NODE };
  const now = Math.floor(Date.now() / 1000);
  const delivery: Delivery = {
    protocolVersion: 1,
    messageType: 'probe',
    issuer: env.GAME_OWNER,
    audience: env.PEER_ORIGIN,
    issuedAt: now,
    expiresAt: now + DELIVERY_TTL,
    nonce: crypto.randomUUID(),
    method: 'POST',
    path: INBOX_PATH,
    bodyHash: await bodyHash(body),
    body,
  };
  const privateKey = await importPKCS8(env.SIGNING_PRIVATE_KEY, 'EdDSA');
  const message = await signDelivery(delivery, privateKey, env.SIGNING_KID);
  async function send() {
    return rejectRedirect(
      await fetch(peerRequest(env.PEER_ORIGIN, [env.PEER_ORIGIN], INBOX_PATH, message), {
        signal: AbortSignal.timeout(5000),
      }),
    );
  }
  try {
    const accepted = await send();
    if (accepted.status !== 200) return context.json({ code: 'PEER_UNAVAILABLE' }, 502);
    const result = (await accepted.json()) as {
      verified?: boolean;
      rowsWritten?: number;
    };
    const replay = await send();
    const replayResult = (await replay.json()) as { code?: string };
    if (!result.verified || replay.status !== 409 || replayResult.code !== 'REPLAY')
      return context.json({ code: 'PEER_CONTRACT' }, 502);
    return context.json({
      reached: true,
      signed: true,
      d1: true,
      replayRejected: true,
      peerRowsWritten: result.rowsWritten,
    });
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'REDIRECT_REJECTED'
        ? 'REDIRECT_REJECTED'
        : error instanceof Error && error.name === 'TimeoutError'
          ? 'PEER_TIMEOUT'
          : 'PEER_UNAVAILABLE';
    return context.json({ code }, 502);
  }
});

app.post(INBOX_PATH, async (context) => {
  const env = context.env;
  const db = connectD1(env.GAME_D1);
  const [fault] = await db
    .select({ id: probeRuns.id })
    .from(probeRuns)
    .where(inArray(probeRuns.id, faultIds))
    .limit(1);
  if (fault?.id === 'fault:redirect')
    return context.redirect(`${env.GAME_OWNER}${API_PATHS.health}`, 302);
  if (fault?.id === 'fault:timeout')
    await new Promise((resolve) => setTimeout(resolve, 6000));
  if (fault?.id === 'fault:unavailable' || fault?.id === 'fault:timeout')
    return context.json({ code: 'TEST_UNAVAILABLE' }, 503);
  const input = await context.req.json<{ message?: unknown }>();
  if (typeof input.message !== 'string')
    return context.json({ code: 'INVALID_MESSAGE' }, 400);
  const peerKey = (await importSPKI(env.PEER_PUBLIC_KEY, 'EdDSA')) as CryptoKey;
  let rowsWritten = 0;
  try {
    await verifyDelivery(input.message, {
      issuer: env.PEER_ORIGIN,
      audience: env.GAME_OWNER,
      kid: env.PEER_KID,
      key: peerKey,
      now: Math.floor(Date.now() / 1000),
      consumeNonce: async (nonce) => {
        const [saved] = await db.batch([
          db
            .insert(probeRuns)
            .values({ id: `nonce:${nonce}` })
            .onConflictDoNothing(),
        ]);
        rowsWritten = saved.meta.rows_written;
        return saved.meta.changes === 1;
      },
    });
    return context.json({ verified: true, rowsWritten });
  } catch (error) {
    if (error instanceof Error && error.message === 'REPLAY')
      return context.json({ code: 'REPLAY' }, 409);
    return context.json({ code: 'SIGNATURE_REJECTED' }, 401);
  }
});
app.notFound((context) => context.json({ code: 'NOT_FOUND' }, 404));
app.onError(() => Response.json({ code: 'TEST_UNAVAILABLE' }, { status: 503 }));
export default app;
