import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import mockQuestions from '../seeds/mock-hiragana.json';
import { disabledFederationPermissions } from '../src/shared/federation';
import { defaultQuestionSettings, emptyQuestion } from '../src/shared/questions';
import { newRoomSettings } from '../src/shared/rooms';
import { loadMatchDefinition } from '../src/worker/catalog/database';
import { validateDefinition } from '../src/worker/catalog/definition';
import { contentHash } from '../src/worker/catalog/hash';
import { publishMatchConfig } from '../src/worker/catalog/publish';
import { changeD1, connectD1, rowBatchesD1, rowsD1 } from '../src/worker/db/d1';
import {
  competitions,
  federationMetadata,
  federationPeers,
  federationPolicies,
  federationQuestionImports,
  federationResultDeliveries,
  instanceRooms,
  instances,
  matchmakingSettings,
  organizations,
  questionAvailability,
  questionCategories,
  questionSetItems,
  questionSets,
  questionSettings,
  questionSubmissions,
  questionVersions,
  rulesetVersions,
} from '../src/worker/db/schema';
import { manageFederation } from '../src/worker/federation/management';
import { syncPeerMetadata } from '../src/worker/federation/metadata';
import { authorizeParticipation } from '../src/worker/federation/participation';
import { foreignHistory } from '../src/worker/federation/results';
import { rules } from '../src/worker/game/rules';
import { failureCode, handleError, notFound } from '../src/worker/http/handlers';
import game, { GameRoom, Matchmaker, Probe } from '../src/worker/index';
import {
  OrganizationError,
  requireAdministrator,
  validId,
} from '../src/worker/organization/access';
import { organizationIdentity } from '../src/worker/organization/database';
import { saveProfile } from '../src/worker/organization/profile';
import { authorizeProbe } from '../src/worker/probes/authorize';
import { publishQuestionCatalog } from '../src/worker/questions/catalog';
import { QuestionPlan } from '../src/worker/questions/plan';
import { participantContext } from '../src/worker/rooms/database';
import { roomResult } from '../src/worker/rooms/rpc';
import type { FederationTestEnv } from './federation-worker';

// Only this isolated QA entry owns setup controls. No test account or bypass enters the game entry.
export { GameRoom, Matchmaker, Probe };

const app = new Hono<{ Bindings: FederationTestEnv }>();
app.onError((error, context) => {
  if (context.req.path.startsWith('/api/probes/game/')) {
    const code = error instanceof OrganizationError ? error.code : failureCode(error);
    console.error(
      JSON.stringify({
        event: 'load_failed',
        code,
      }),
    );
    if (!(error instanceof OrganizationError)) return context.json({ code }, 500);
  }
  return handleError(error, context);
});
app.notFound(notFound);
app.use('/api/probes/game/*', authorizeProbe, bodyLimit({ maxSize: 4096 }));
async function testIdentity(env: FederationTestEnv) {
  if (
    !['A', 'B'].includes(env.TEST_NODE) ||
    !env.TEST_ADMIN_SUBJECT ||
    env.GAME_OWNER !==
      `https://quiz-relay-federation-${env.TEST_NODE.toLowerCase()}-test.quiz-relay.workers.dev`
  )
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  const db = connectD1(env.GAME_D1),
    identity = await organizationIdentity(db, env.TEST_ADMIN_SUBJECT);
  requireAdministrator(identity.account);
  if (identity.organization.name !== `連携検証 ${env.TEST_NODE}`)
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  return { db, ...identity };
}
app.get('/api/probes/game/status', async (context) => {
  const { db } = await testIdentity(context.env);
  return context.json({
    gameReady: true,
    node: context.env.TEST_NODE,
    instances: await db
      .select({ id: instances.id, name: instances.name, state: instances.state })
      .from(instances)
      .limit(10),
    metadata: await db
      .select({
        instanceId: federationMetadata.instanceId,
        peerOrigin: federationMetadata.peerOrigin,
        lastSuccessAt: federationMetadata.lastSuccessAt,
        errorCode: federationMetadata.errorCode,
      })
      .from(federationMetadata)
      .limit(10),
    imports: await db
      .select({
        instanceId: federationQuestionImports.instanceId,
        sourceInstanceId: federationQuestionImports.sourceInstanceId,
        peerOrigin: federationQuestionImports.peerOrigin,
        enabled: federationQuestionImports.enabled,
        lastSuccessAt: federationQuestionImports.lastSuccessAt,
        errorCode: federationQuestionImports.errorCode,
      })
      .from(federationQuestionImports)
      .limit(10),
  });
});
app.get('/api/probes/game/database-read', async (context) => {
  const env = context.env;
  if (
    !['A', 'B'].includes(env.TEST_NODE) ||
    env.GAME_OWNER !==
      `https://quiz-relay-federation-${env.TEST_NODE.toLowerCase()}-test.quiz-relay.workers.dev`
  )
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  const started = Date.now();
  const db = connectD1(env.GAME_D1);
  await db.all(sql`select 1 as ready`);
  await db.select({ id: organizations.id }).from(organizations).limit(1);
  return context.json({ ready: true, elapsedMs: Date.now() - started });
});
// Reversible one-sided consent tests, restricted to B's already configured QA peer.
app.post('/api/probes/game/peer-state', async (context) => {
  const { db } = await testIdentity(context.env);
  if (
    context.env.TEST_NODE !== 'B' ||
    context.env.PEER_ORIGIN !==
      'https://quiz-relay-federation-a-test.quiz-relay.workers.dev'
  )
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  const input = await context.req.json<Record<string, unknown>>();
  const flags = ['approved', 'discovered', 'participationBlocked'] as const;
  const read = async () => {
    const [peer] = await db
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.origin, context.env.PEER_ORIGIN));
    if (!peer) throw new OrganizationError('QA_TARGET_MISMATCH', 403);
    return Object.fromEntries(flags.map((key) => [key, peer[key]]));
  };
  if (Object.keys(input).length === 0) return context.json(await read());
  if (Object.keys(input).sort().join(',') !== 'expected,next')
    throw new OrganizationError('INVALID_SETUP', 400);
  for (const value of [input.expected, input.next])
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== flags.slice().sort().join(',') ||
      Object.values(value).some((item) => typeof item !== 'boolean')
    )
      throw new OrganizationError('INVALID_SETUP', 400);
  await changeD1(db, async (writes) => {
    const current = await read();
    if (flags.some((key) => current[key] !== (input.expected as typeof current)[key]))
      throw new OrganizationError('EDIT_CONFLICT', 409);
    writes.push(
      db
        .update(federationPeers)
        .set(
          input.next as {
            approved: boolean;
            discovered: boolean;
            participationBlocked: boolean;
          },
        )
        .where(eq(federationPeers.origin, context.env.PEER_ORIGIN)),
    );
  });
  return context.json(await read());
});
app.post('/api/probes/game/persistence', async (context) => {
  const { db, organization } = await testIdentity(context.env);
  const input = await context.req.json<Record<string, unknown>>();
  if (Object.keys(input).join(',') !== 'instanceId')
    throw new OrganizationError('INVALID_SETUP', 400);
  const [instance] = await db
    .select()
    .from(instances)
    .where(
      and(
        eq(instances.id, validId(input.instanceId)),
        eq(instances.organizationId, organization.id),
      ),
    );
  if (!instance || instance.name !== `${context.env.TEST_NODE}-1`)
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  const rooms = await db
    .select()
    .from(instanceRooms)
    .where(eq(instanceRooms.instanceId, instance.id))
    .limit(10);
  return context.json({
    rooms: await Promise.all(
      rooms.map(async (row) => ({
        roomId: row.roomId,
        ...(await context.env.GAME_ROOM.get(
          context.env.GAME_ROOM.idFromString(row.roomId),
        ).persistenceStatus(instance.id)),
      })),
    ),
  });
});
app.post('/api/probes/game/deliveries', async (context) => {
  const { db, organization } = await testIdentity(context.env);
  const input = await context.req.json<Record<string, unknown>>();
  if (Object.keys(input).join(',') !== 'instanceId')
    throw new OrganizationError('INVALID_SETUP', 400);
  const [instance] = await db
    .select()
    .from(instances)
    .where(
      and(
        eq(instances.id, validId(input.instanceId)),
        eq(instances.organizationId, organization.id),
      ),
    );
  if (
    !instance ||
    ![`${context.env.TEST_NODE}-1`, `${context.env.TEST_NODE}-2`].includes(instance.name)
  )
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  const deliveries = await db
    .select({
      eventId: federationResultDeliveries.eventId,
      resultId: federationResultDeliveries.resultId,
      finishedAt: sql<number>`json_extract(${federationResultDeliveries.payload}, '$.finishedAt')`,
      attempts: federationResultDeliveries.attempts,
      nextAttemptAt: federationResultDeliveries.nextAttemptAt,
      leaseUntil: federationResultDeliveries.leaseUntil,
      receivedAt: federationResultDeliveries.receivedAt,
      errorCode: federationResultDeliveries.errorCode,
      quarantined: federationResultDeliveries.quarantined,
    })
    .from(federationResultDeliveries)
    .where(eq(federationResultDeliveries.instanceId, instance.id))
    .orderBy(
      desc(sql`json_extract(${federationResultDeliveries.payload}, '$.finishedAt')`),
    )
    .limit(20);
  return context.json({ deliveries });
});
app.post('/api/probes/game/setup', async (context) => {
  const env = context.env,
    { db, account, organization } = await testIdentity(env),
    input = await context.req.json(),
    id = validId(input.instanceId);
  if (Object.keys(input).join(',') !== 'instanceId')
    throw new OrganizationError('INVALID_SETUP', 400);
  const [instance] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), eq(instances.organizationId, organization.id)));
  if (!instance || ![`${env.TEST_NODE}-1`, `${env.TEST_NODE}-2`].includes(instance.name))
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  if (!account.displayName)
    await saveProfile(
      db,
      env.TEST_ADMIN_SUBJECT ?? '',
      { displayName: `${env.TEST_NODE} 検証参加者`, revision: account.profileRevision },
      'default',
    );
  const [existing] = await db
    .select()
    .from(matchmakingSettings)
    .where(
      and(
        eq(matchmakingSettings.owner, instance.owner),
        eq(matchmakingSettings.profile, 'default'),
      ),
    );
  if (!existing) {
    const config = { ...rules, showSelections: true },
      definition = await validateDefinition({
        competition: { owner: instance.owner, id: 'federation-qa', version: 1 },
        ruleset: { owner: instance.owner, id: 'federation-qa', version: 1 },
        questionSet: { owner: instance.owner, id: 'federation-qa', version: 1 },
        rules: config,
        questions: mockQuestions,
        playersPerMatch: 2,
        rulesHash: await contentHash(config),
        manifestHash: await contentHash(mockQuestions),
      });
    await changeD1(db, async (writes) => {
      writes.push(
        db.insert(rulesetVersions).values({
          owner: instance.owner,
          rulesetId: 'federation-qa',
          version: 1,
          rulesHash: definition.rulesHash,
          config,
        }),
        ...rowBatchesD1(
          questionVersions,
          definition.questions.map((question) => ({
            owner: instance.owner,
            questionId: question.id,
            version: 1,
            payload: question,
          })),
        ),
        ...rowBatchesD1(
          questionAvailability,
          definition.questions.map((question) => ({
            owner: instance.owner,
            questionId: question.id,
          })),
        ),
      );
      for (const setId of ['federation-qa', 'authored-casual']) {
        writes.push(
          db.insert(questionSets).values({
            owner: instance.owner,
            setId,
            version: 1,
            manifestHash: definition.manifestHash,
          }),
          ...rowBatchesD1(
            questionSetItems,
            definition.questions.map((question, index) => ({
              owner: instance.owner,
              setId,
              setVersion: 1,
              ordinal: index + 1,
              questionId: question.id,
              questionVersion: 1,
            })),
          ),
          db.insert(competitions).values({
            owner: instance.owner,
            competitionId: setId,
            version: 1,
            playersPerMatch: 2,
            rulesetId: 'federation-qa',
            rulesetVersion: 1,
            setId,
            setVersion: 1,
          }),
        );
      }
      writes.push(
        rowsD1(matchmakingSettings, [
          {
            owner: instance.owner,
            profile: 'default',
            competitionId: 'federation-qa',
            competitionVersion: 1,
          },
          {
            owner: instance.owner,
            profile: 'default-casual',
            competitionId: 'authored-casual',
            competitionVersion: 1,
          },
        ]),
        db
          .update(instances)
          .set({
            state: 'published',
            casualConfig: { ...instance.casualConfig, enabled: true, players: 2 },
            operationRevision: instance.operationRevision + 1,
          })
          .where(eq(instances.id, id)),
      );
    });
  }
  return context.json({ gameReady: true, instanceId: id, seeded: !existing });
});
app.post('/api/probes/game/questions-seed', async (context) => {
  const env = context.env,
    { db, account, organization } = await testIdentity(env),
    input = await context.req.json(),
    id = validId(input.instanceId);
  if (Object.keys(input).join(',') !== 'instanceId')
    throw new OrganizationError('INVALID_SETUP', 400);
  const [instance] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), eq(instances.organizationId, organization.id)));
  if (!instance || ![`${env.TEST_NODE}-1`, `${env.TEST_NODE}-2`].includes(instance.name))
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  const existing = await db
    .select({ id: questionSubmissions.id })
    .from(questionSubmissions)
    .where(eq(questionSubmissions.instanceId, id))
    .limit(1);
  if (existing.length) return context.json({ ok: true, seeded: false });
  const categoryId = crypto.randomUUID();
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .insert(questionCategories)
        .values({ id: categoryId, instanceId: id, name: '連携検証' }),
      db
        .insert(questionSettings)
        .values({
          instanceId: id,
          config: { ...defaultQuestionSettings, showAuthor: true },
        })
        .onConflictDoNothing(),
    );
  });
  await changeD1(db, async (writes) => {
    const plan = new QuestionPlan(id, instance.owner);
    await plan.load(db, { operation: 'qa-shared-seed' });
    for (const question of mockQuestions) {
      const row = plan.draft(
        account.actorId,
        `${env.TEST_NODE} 検証作問者`,
        {
          ...emptyQuestion(),
          categoryId,
          text: question.text,
          displayAnswer: question.answer,
          readings: [question.answer],
          explanation: question.explanation || '連携検証用の解説',
          evidence: '検証用の独自作成',
          source: 'Quiz Relay検証用',
          difficulty: 0,
        },
        { status: 'approved' },
      );
      plan.save(row, { publishedId: await plan.publish(row) });
    }
    plan.flush(writes);
    await publishQuestionCatalog(
      db,
      writes,
      id,
      instance.owner,
      env.GAME_CONFIG_PROFILE,
      undefined,
      {
        submissions: [...plan.changedSubmissions.values()],
        questions: plan.newVersions,
        availability: [...plan.availability.values()],
      },
    );
  });
  return context.json({ ok: true, seeded: true });
});
app.post('/api/probes/game/peer', async (context) => {
  const env = context.env,
    { db } = await testIdentity(env),
    [peer] = await db
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.origin, env.PEER_ORIGIN));
  if (!peer)
    await manageFederation(db, env.TEST_ADMIN_SUBJECT ?? '', {
      operation: 'peer',
      origin: env.PEER_ORIGIN,
      name: `連携検証 ${env.TEST_NODE === 'A' ? 'B' : 'A'}`,
      kid: env.PEER_KID,
      publicKey: env.PEER_PUBLIC_KEY,
      approved: true,
      revision: 0,
    });
  return context.json({ ok: true });
});
app.post('/api/probes/game/sync', async (context) => {
  const env = context.env;
  await testIdentity(env);
  const input = await context.req.json();
  return context.json(
    await syncPeerMetadata(env, env.TEST_ADMIN_SUBJECT ?? '', {
      operation: 'syncMetadata',
      instanceId: validId(input.instanceId),
      peerOrigin: env.PEER_ORIGIN,
    }),
  );
});
app.post('/api/probes/game/policy', async (context) => {
  const env = context.env,
    { db } = await testIdentity(env),
    input = await context.req.json(),
    instanceId = validId(input.instanceId),
    peerInstanceId = validId(input.peerInstanceId);
  const [metadata] = await db
    .select()
    .from(federationMetadata)
    .where(
      and(
        eq(federationMetadata.instanceId, instanceId),
        eq(federationMetadata.peerOrigin, env.PEER_ORIGIN),
      ),
    );
  if (!metadata?.payload.instances.some((instance) => instance.id === peerInstanceId))
    throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
  await manageFederation(db, env.TEST_ADMIN_SUBJECT ?? '', {
    operation: 'policy',
    instanceId,
    peerInstanceId,
    peerOrigin: env.PEER_ORIGIN,
  });
  const [policy] = await db
      .select()
      .from(federationPolicies)
      .where(
        and(
          eq(federationPolicies.instanceId, instanceId),
          eq(federationPolicies.peerOrigin, env.PEER_ORIGIN),
          eq(federationPolicies.peerInstanceId, peerInstanceId),
        ),
      ),
    permissions = disabledFederationPermissions();
  permissions.send.ranked = true;
  permissions.receive.ranked = true;
  permissions.send.casual = true;
  permissions.receive.casual = true;
  permissions.send.results = true;
  permissions.receive.results = true;
  return context.json(
    await manageFederation(db, env.TEST_ADMIN_SUBJECT ?? '', {
      operation: 'policies',
      items: [{ id: policy.id, revision: policy.revision, permissions }],
    }),
  );
});
// Bounded synthetic identities exist only in the token-protected A/B QA entry.
// The production Clerk middleware and ordinary federation/session paths are unchanged.
async function loadIdentity(env: FederationTestEnv, input: Record<string, unknown>) {
  const runId = validId(input.runId),
    index = Number(input.index);
  if (!Number.isInteger(index) || index < 0 || index > 12)
    throw new OrganizationError('INVALID_LOAD_ACTOR', 400);
  const { db, organization } = await testIdentity(env),
    subject = `qa-load:${runId}:${index}`,
    identity = await organizationIdentity(db, subject);
  if (!identity.account.displayName)
    await saveProfile(
      db,
      subject,
      {
        displayName: `負荷検証 ${runId.slice(0, 4)} ${index}`,
        revision: identity.account.profileRevision,
      },
      'default',
    );
  const [instance] = await db
    .select()
    .from(instances)
    .where(
      and(
        eq(instances.organizationId, organization.id),
        eq(instances.name, `${env.TEST_NODE}-2`),
      ),
    );
  if (!instance) throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  return {
    db,
    subject,
    organization,
    instance,
    actorId: identity.account.actorId,
    runId,
  };
}
app.post('/api/probes/game/load/prepare', async (context) => {
  await loadIdentity(context.env, await context.req.json<Record<string, unknown>>());
  return context.json({ prepared: true });
});
app.post('/api/probes/game/load/history', async (context) => {
  const input = await context.req.json<Record<string, unknown>>();
  const identity = await loadIdentity(context.env, input);
  if (context.env.TEST_NODE !== 'B' || Number(input.index) !== 3)
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  const page = await foreignHistory(
    context.env,
    identity.subject,
    identity.organization.id,
  );
  return context.json({
    history: page.history.map((entry) => ({ resultId: entry.resultId })),
  });
});
app.post('/api/probes/game/load/config', async (context) => {
  const input = await context.req.json<Record<string, unknown>>(),
    { db, instance } = await loadIdentity(context.env, { ...input, index: 0 });
  if (context.env.TEST_NODE !== 'A' || ![2, 4].includes(Number(input.players)))
    throw new OrganizationError('INVALID_LOAD_CONFIG', 400);
  const definition = await loadMatchDefinition({
    ...context.env,
    GAME_OWNER: instance.owner,
  });
  return context.json(
    await publishMatchConfig(
      db,
      {
        owner: instance.owner,
        competitionId: definition.competition.id,
        rulesetId: definition.ruleset.id,
        questionSet: {
          id: definition.questionSet.id,
          version: definition.questionSet.version,
        },
        playersPerMatch: Number(input.players),
        rules: definition.rules,
      },
      'default',
    ),
  );
});
app.post('/api/probes/game/load/enter', async (context) => {
  const input = await context.req.json<Record<string, unknown>>(),
    identity = await loadIdentity(context.env, input),
    operationId = validId(input.operationId);
  if (input.mode === 'foreign') {
    if (context.env.TEST_NODE !== 'B')
      throw new OrganizationError('QA_TARGET_MISMATCH', 403);
    return context.json(
      await authorizeParticipation(context.env, identity.subject, {
        sourceInstanceId: identity.organization.id,
        hostInstanceId: '4ed56d67-fd75-4d02-8f0a-64966df2e897',
        peerOrigin: context.env.PEER_ORIGIN,
        mode: 'ranked',
        operationId,
      }),
    );
  }
  if (context.env.TEST_NODE !== 'A')
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  const maker = context.env.MATCHMAKER.getByName(identity.organization.id);
  if (input.mode === 'ranked')
    return context.json(
      await maker.enter(
        identity.actorId,
        `負荷検証 ${input.index}`,
        undefined,
        false,
        { id: identity.instance.id, owner: identity.instance.owner },
        false,
        operationId,
      ),
    );
  if (input.mode !== 'room') throw new OrganizationError('INVALID_LOAD_MODE', 400);
  const participant = await participantContext(
      context.env,
      identity.instance.id,
      'room',
      identity.subject,
    ),
    creation =
      Number(input.index) === 4
        ? {
            room: identity.runId,
            operationId,
            password: '',
            settings: {
              ...newRoomSettings(false),
              name: `負荷検証 ${identity.runId.slice(0, 4)}`,
              public: false,
              presenter: true,
              source: 'original',
              winMode: 'questions',
              count: 12,
              mistakes: null,
            },
            questions: mockQuestions.slice(0, 12).map((question) => ({
              text: question.text,
              displayAnswer: question.answer,
              readings: [question.answer],
              explanation: question.explanation,
            })),
          }
        : undefined;
  const invite = creation
    ? ''
    : await context.env.GAME_ROOM.getByName(`room:${identity.runId}`).createdRoomInvite(
        (await loadIdentity(context.env, { ...input, index: 4 })).actorId,
      );
  return context.json(
    await maker.enterRoom(
      participant.actor,
      identity.runId,
      participant.scope,
      { operationId, password: '', invite },
      creation,
    ),
  );
});
app.post('/api/probes/game/load/room', async (context) => {
  const input = await context.req.json<Record<string, unknown>>(),
    identity = await loadIdentity(context.env, input);
  if (context.env.TEST_NODE !== 'A' || Number(input.index) < 4)
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  const participant = await participantContext(
      context.env,
      identity.instance.id,
      'room',
      identity.subject,
      undefined,
      true,
    ),
    lobby = context.env.GAME_ROOM.getByName(`room:${identity.runId}`);
  if (input.action === 'session')
    return context.json(
      roomResult(await lobby.userRoomGameSession(identity.actorId, String(input.token))),
    );
  const view = roomResult(
    await lobby.userRoomView(identity.actorId, String(input.token)),
  );
  if (input.action === 'leave') {
    return context.json(
      await context.env.MATCHMAKER.getByName(identity.organization.id).cancel(
        identity.actorId,
        identity.runId,
        false,
        identity.instance.id,
        false,
      ),
    );
  }
  if (!['ready', 'start', 'leave', 'return'].includes(String(input.action)))
    throw new OrganizationError('INVALID_LOAD_ACTION', 400);
  const result = roomResult(
    await lobby.mutateUserRoom(participant.actor, {
      action: input.action,
      ready: true,
      revision: view.revision,
      operationId: validId(input.operationId),
    }),
  );
  return context.json(
    input.action === 'return'
      ? {
          ...result,
          lobby: roomResult(
            await lobby.userRoomView(identity.actorId, String(input.token)),
          ),
        }
      : result,
  );
});
app.get('/api/probes/game/load/socket', async (context) => {
  const input = Object.fromEntries(new URL(context.req.url).searchParams),
    identity = await loadIdentity(context.env, input),
    token = context.req.header('X-QA-Session') ?? '',
    parent = input.kind === 'lobby',
    room = parent ? identity.runId : validId(input.room),
    stub = context.env.GAME_ROOM.getByName(`${parent ? 'room' : '1c'}:${room}`);
  if (context.env.TEST_NODE !== 'A')
    throw new OrganizationError('QA_TARGET_MISMATCH', 403);
  if (parent) roomResult(await stub.userRoomView(identity.actorId, token));
  else if (!(await stub.reservationIdentity(identity.actorId, token)))
    throw new OrganizationError('SESSION_REQUIRED', 401);
  const headers = new Headers(context.req.raw.headers);
  headers.set('X-Game-Session', token);
  headers.set('X-Game-Instance', identity.instance.id);
  return stub.fetch(new Request(context.req.raw, { headers }));
});
app.route('/', game);
export default Object.assign(app, {
  scheduled: (
    event: ScheduledController,
    env: FederationTestEnv & { QA_PAUSE_MAINTENANCE?: string },
    context: ExecutionContext,
  ) => {
    if (env.QA_PAUSE_MAINTENANCE === 'true' && ['A', 'B'].includes(env.TEST_NODE)) return;
    return game.scheduled(event, env, context);
  },
});
