import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { defaultQuestionSettings, emptyQuestion } from '../src/shared/questions.ts';
import { newRoomSettings } from '../src/shared/rooms.ts';
import { loadMatchDefinition } from '../src/worker/catalog/database.ts';
import { contentHash } from '../src/worker/catalog/hash.ts';
import {
  accountWithdrawals,
  instanceGrants,
  instances,
  matchResults,
  organizationAccounts,
  organizations,
  personalQuestionSets,
  questionCategories,
  questionReports,
  questionSettings,
  questionSubmissions,
  resultPlayers,
  userReports,
} from '../src/worker/db/schema.ts';
import type { Env } from '../src/worker/env.ts';
import { rules } from '../src/worker/game/rules.ts';
import { actorForSubject } from '../src/worker/organization/access.ts';
import { allowedInstanceActors } from '../src/worker/organization/database.ts';
import { questionMutation } from '../src/worker/questions/database.ts';
import { commitResult } from '../src/worker/results/database.ts';
import type { ResultRecord } from '../src/worker/results/record.ts';
import {
  createGuest,
  ensureCasualCatalog,
  guestIdentity,
  mutatePersonalSet,
  participantContext,
  personalSets,
  roomDefinition,
  roomOptions,
  saveCasualSettings,
} from '../src/worker/rooms/database.ts';
import { history, report } from '../src/worker/rooms/reports.ts';

// Called only inside check-question-database's newly created, password-protected cluster.
export async function verifyRooms(
  db: PostgresJsDatabase,
  address: string,
  instanceId: string,
  actors: string[],
) {
  const target = new URL(address);
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.pathname, '/quiz_relay_questions_test');
  const password = Buffer.from(randomBytes(24)).toString('hex');
  for (const role of ['quiz_organization', 'quiz_game_reader'])
    await db.execute(sql.raw(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`));
  const roleUrl = (role: string) => {
    const url = new URL(address);
    url.username = role;
    url.password = password;
    return url.toString();
  };
  const env = {
    ORGANIZATION_DATABASE_URL: roleUrl('quiz_organization'),
    GAME_DATABASE_URL: roleUrl('quiz_game_reader'),
    GAME_CONFIG_PROFILE: 'local',
  } as Env;
  let [instance] = await db.select().from(instances).where(eq(instances.id, instanceId));
  instanceId = crypto.randomUUID();
  [instance] = await db
    .insert(instances)
    .values({
      id: instanceId,
      organizationId: instance.organizationId,
      owner: `urn:uuid:${instanceId}`,
      name: '部屋隔離検証',
      state: 'published',
    })
    .returning();
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, instance.organizationId));
  const adminSubject = 'qa-room-admin',
    authorSubject = 'qa-room-author';
  const subjects = [adminSubject, authorSubject, 'qa-room-reviewer'];
  actors = await Promise.all(
    subjects.map((s) => actorForSubject(organization.identityNamespace, s)),
  );
  await db.insert(organizationAccounts).values(
    subjects.map((subject, i) => ({
      organizationId: organization.id,
      subject,
      actorId: actors[i],
      displayName: subject,
      administrator: i === 0,
    })),
  );
  await db
    .insert(instanceGrants)
    .values({ instanceId, actorId: actors[2], permission: 'questions' });
  const mutate = (subject: string, input: Record<string, unknown>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE quiz_organization`);
      return questionMutation(tx, subject, instanceId, input, 'local');
    });
  await mutate(adminSubject, { operation: 'category', name: '部屋検証' });
  const [category] = await db
    .select()
    .from(questionCategories)
    .where(eq(questionCategories.name, '部屋検証'));
  await mutate(adminSubject, {
    operation: 'save',
    input: {
      ...emptyQuestion(),
      text: '日本の首都は？',
      displayAnswer: '東京',
      readings: ['とうきょう'],
      explanation: '検証用の解説。',
      evidence: '検証用の根拠。',
      source: '検証用',
      categoryId: category.id,
    },
  });
  let [submission] = await db
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.authorId, actors[0]));
  await mutate(adminSubject, {
    operation: 'submit',
    id: submission.id,
    revision: submission.revision,
  });
  [submission] = await db
    .select()
    .from(questionSubmissions)
    .where(eq(questionSubmissions.id, submission.id));
  if (submission.status === 'pending')
    await mutate(subjects[2], {
      operation: 'approve',
      id: submission.id,
      revision: submission.revision,
      reason: '',
    });
  const config = { enabled: true, players: 2, casualGuests: true, roomGuests: true };
  await ensureCasualCatalog(env, instanceId);
  const request = {
    id: instanceId,
    config,
    revision: instance.operationRevision,
    operationId: crypto.randomUUID(),
  };
  await saveCasualSettings(env, adminSubject, request);
  await saveCasualSettings(env, adminSubject, request);
  await assert.rejects(
    saveCasualSettings(env, adminSubject, {
      ...request,
      config: { ...config, players: 3 },
    }),
    /OPERATION_CONFLICT/,
  );
  await assert.rejects(
    saveCasualSettings(env, authorSubject, {
      ...request,
      operationId: crypto.randomUUID(),
    }),
    /ADMIN_REQUIRED/,
  );
  const definition = await loadMatchDefinition({
    ...env,
    GAME_OWNER: instance.owner,
    GAME_CONFIG_PROFILE: 'local-casual',
  });
  assert.equal(definition.kind, 'casual');
  assert.equal(definition.playersPerMatch, 2);
  const categories = await roomOptions(env, instanceId);
  assert.deepEqual(
    categories.map((c) => c.id).sort(),
    (
      await db
        .select()
        .from(questionCategories)
        .where(eq(questionCategories.instanceId, instanceId))
    )
      .map((c) => c.id)
      .sort(),
  );
  assert.ok(categories.length);
  const settings = { ...newRoomSettings(true), capacity: 8 };
  const normal = await roomDefinition(
    env,
    { id: instanceId, owner: instance.owner, mode: 'room' },
    settings,
    [],
    crypto.randomUUID(),
  );
  assert.equal(normal.playersPerMatch, 8);
  assert.ok(normal.questions.length);
  assert.equal(normal.original, false);
  assert.equal(normal.questions[0].authorName, undefined);
  await db
    .insert(questionSettings)
    .values({ instanceId, config: defaultQuestionSettings })
    .onConflictDoNothing();
  const [questionConfig] = await db
    .select()
    .from(questionSettings)
    .where(eq(questionSettings.instanceId, instanceId));
  await db
    .update(questionSettings)
    .set({ config: { ...questionConfig.config, showAuthor: true } })
    .where(eq(questionSettings.instanceId, instanceId));
  const named = await roomDefinition(
    env,
    { id: instanceId, owner: instance.owner, mode: 'room' },
    settings,
    [],
    crypto.randomUUID(),
  );
  assert.equal(named.questions[0].authorName, adminSubject);
  assert.equal(normal.questions[0].authorName, undefined);
  await db
    .update(questionSettings)
    .set({ config: questionConfig.config })
    .where(eq(questionSettings.instanceId, instanceId));
  const hidden = await roomDefinition(
    env,
    { id: instanceId, owner: instance.owner, mode: 'room' },
    settings,
    [],
    crypto.randomUUID(),
  );
  assert.equal(hidden.questions[0].authorName, undefined);
  assert.equal(named.questions[0].authorName, adminSubject);
  const questions = [
    {
      text: '日本の首都は？',
      displayAnswer: '東京',
      readings: ['とうきょう'],
      explanation: '',
    },
  ];
  const set = {
    action: 'save',
    id: crypto.randomUUID(),
    name: '個人用',
    revision: 0,
    questions,
    operationId: crypto.randomUUID(),
  };
  await mutatePersonalSet(env, authorSubject, set);
  await mutatePersonalSet(env, authorSubject, set);
  assert.equal(
    (await personalSets(env, authorSubject)).filter((s) => s.id === set.id).length,
    1,
  );
  assert.equal(
    (await personalSets(env, adminSubject)).some((s) => s.id === set.id),
    false,
  );
  await assert.rejects(
    mutatePersonalSet(env, adminSubject, {
      ...set,
      revision: 1,
      operationId: crypto.randomUUID(),
    }),
    /EDIT_CONFLICT/,
  );
  const remove = {
    ...set,
    action: 'delete',
    revision: 1,
    operationId: crypto.randomUUID(),
  };
  await mutatePersonalSet(env, authorSubject, remove);
  await mutatePersonalSet(env, authorSubject, remove);
  assert.equal(
    (await personalSets(env, authorSubject)).some((s) => s.id === set.id),
    false,
  );
  const original = await roomDefinition(
    env,
    { id: instanceId, owner: instance.owner, mode: 'room' },
    { ...settings, source: 'original' },
    questions,
    crypto.randomUUID(),
  );
  assert.equal(original.questions.length, 1);
  assert.equal(original.original, true);
  const token = Buffer.from(randomBytes(32)).toString('hex'),
    guestRequest = { name: '検証ゲスト', operationId: crypto.randomUUID() };
  await createGuest(env, guestRequest, token);
  const guest = await guestIdentity(env, token);
  await createGuest(env, guestRequest, token);
  assert.equal((await guestIdentity(env, token)).expiresAt, guest.expiresAt);
  await assert.rejects(
    createGuest(env, { ...guestRequest, name: '変更' }, token),
    /OPERATION_CONFLICT/,
  );
  const identity = await participantContext(env, instanceId, 'room', undefined, token);
  assert.equal(identity.actor.guest, true);
  await assert.rejects(
    participantContext(env, instanceId, 'room', undefined, token, false, true),
    /LOGIN_REQUIRED/,
  );
  assert.deepEqual(await allowedInstanceActors(env, identity.scope, [guest.actorId]), [
    guest.actorId,
  ]);
  await db
    .update(instances)
    .set({ casualPauseReason: '検証停止' })
    .where(eq(instances.id, instanceId));
  assert.deepEqual(await allowedInstanceActors(env, identity.scope, [guest.actorId]), []);
  await assert.rejects(
    participantContext(env, instanceId, 'casual', undefined, token),
    /CASUAL_PAUSED/,
  );
  assert.equal(
    (await participantContext(env, instanceId, 'room', undefined, token, true)).actor.id,
    guest.actorId,
  );
  await db
    .update(instances)
    .set({ casualPauseReason: '' })
    .where(eq(instances.id, instanceId));
  const ref = { owner: instance.owner, id: 'room-fixture', version: 1 };
  const player = (id: string, name: string, guest = false) => ({
    id,
    name,
    guest,
    correct: 1,
    mistakes: 0,
    locked: false,
    disqualified: false,
    connected: true,
    ratingDelta: 0,
  });
  const record: ResultRecord = {
    version: 1,
    owner: instance.owner,
    matchId: crypto.randomUUID(),
    kind: 'room',
    startedAt: Date.now() - 1000,
    result: {
      id: crypto.randomUUID(),
      finishedAt: Date.now(),
      winnerId: actors[1],
      reason: 'exhausted',
    },
    definition: {
      competition: ref,
      ruleset: ref,
      questionSet: ref,
      rulesHash: 'a'.repeat(64),
      manifestHash: 'b'.repeat(64),
      playersPerMatch: 2,
      rules: { ...rules, showSelections: true },
      kind: 'room',
      original: true,
    },
    ratingVersion: 1,
    players: [
      player(actors[1], '作者'),
      player(guest.actorId, guest.name, true),
      { ...player(actors[0], '出題者'), role: 'presenter' },
    ],
    completedQuestions: [
      {
        id: original.questions[0].id,
        ...questions[0],
        source: '',
        correct: true,
        participants: [actors[1], guest.actorId],
      },
    ],
  };
  await commitResult(db, record);
  await commitResult(db, record);
  assert.equal(
    (
      await db
        .select()
        .from(matchResults)
        .where(eq(matchResults.resultId, record.result.id))
    ).length,
    1,
  );
  await assert.rejects(
    commitResult(db, {
      ...record,
      players: record.players.map((p) => ({ ...p, correct: 4 })),
    }),
    /RESULT_CONFLICT/,
  );
  const beforeRanking = (
    await history(
      env,
      await participantContext(env, instanceId, 'room', authorSubject, undefined, true),
    )
  ).ranking;
  assert.equal((await history(env, identity)).history[0].kind, 'room');
  const presenter = await participantContext(
    env,
    instanceId,
    'room',
    adminSubject,
    undefined,
    true,
  );
  assert.equal((await history(env, presenter)).history[0].outcome, 'presenter');
  assert.deepEqual((await history(env, identity)).ranking, []);
  const questionReport = {
    action: 'question',
    kind: 'defect',
    reason: '表記確認',
    questionId: original.questions[0].id,
    resultId: record.result.id,
    operationId: crypto.randomUUID(),
  };
  await report(env, identity, questionReport);
  await report(env, identity, questionReport);
  assert.equal(
    (
      await db
        .select()
        .from(questionReports)
        .where(eq(questionReports.questionId, original.questions[0].id))
    ).length,
    1,
  );
  const userReport = {
    action: 'user',
    reason: '操作確認',
    actorId: actors[1],
    resultId: record.result.id,
    operationId: crypto.randomUUID(),
  };
  await report(env, identity, userReport);
  await report(env, identity, userReport);
  assert.equal(
    (
      await db
        .select()
        .from(userReports)
        .where(eq(userReports.id, userReport.operationId))
    ).length,
    1,
  );
  const author = await participantContext(
    env,
    instanceId,
    'room',
    authorSubject,
    undefined,
    true,
  );
  await assert.rejects(
    report(env, author, {
      ...userReport,
      actorId: guest.actorId,
      operationId: crypto.randomUUID(),
    }),
    /REPORT_NOT_ALLOWED/,
  );
  assert.deepEqual((await history(env, author)).ranking, beforeRanking);
  const old = structuredClone(record);
  old.matchId = crypto.randomUUID();
  old.result.id = crypto.randomUUID();
  old.result.finishedAt = Date.now() - 31 * 86400000;
  old.startedAt = old.result.finishedAt - 1000;
  await commitResult(db, old);
  const [stored] = await db
    .select()
    .from(matchResults)
    .where(eq(matchResults.resultId, old.result.id));
  assert.equal(stored.payload.completedQuestions, undefined);
  assert.equal(stored.payload.players[1].name, 'ゲスト');
  assert.equal(
    (await history(env, identity)).history.some((h) => h.resultId === old.result.id),
    false,
  );
  await commitResult(db, old);
  const indexed = await db
    .select()
    .from(resultPlayers)
    .where(eq(resultPlayers.resultId, old.result.id));
  assert.equal(indexed.find((p) => p.actorId === guest.actorId)?.name, 'ゲスト');
  // A restored personal set must also be erased by the maintenance role after retirement.
  const [withdrawal] = await db
    .select()
    .from(accountWithdrawals)
    .where(eq(accountWithdrawals.organizationId, organization.id));
  assert.ok(withdrawal);
  const restoredId = crypto.randomUUID();
  await db.insert(personalQuestionSets).values({
    id: restoredId,
    organizationId: organization.id,
    authorId: withdrawal.actorId,
    name: '復元セット',
    questions,
  });
  await db.execute(sql`select quiz_game.erase_personal_sets()`);
  assert.equal(
    (
      await db
        .select()
        .from(personalQuestionSets)
        .where(eq(personalQuestionSets.id, restoredId))
    ).length,
    0,
  );
  assert.equal(
    (
      await db
        .select()
        .from(personalQuestionSets)
        .where(eq(personalQuestionSets.id, set.id))
    ).length,
    0,
  );
  assert.equal(await contentHash(token), guest.actorId);
  console.log(
    'PASS: casual/room real-role settings and categories, approved/original selection, creator-only sets, fixed retries, guest admission/pause, guest reports/target exclusion, nonrank result replay and 30-day privacy',
  );
}
