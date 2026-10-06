import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { defaultQuestionSettings, emptyQuestion } from '../src/shared/questions.ts';
import { newRoomSettings } from '../src/shared/rooms.ts';
import { loadMatchDefinition } from '../src/worker/catalog/database.ts';
import { contentHash } from '../src/worker/catalog/hash.ts';
import { connectDatabase } from '../src/worker/db/connection.ts';
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
import {
  allowedInstanceActors,
  organizationDatabase,
  overview,
} from '../src/worker/organization/database.ts';
import { questionMutation } from '../src/worker/questions/database.ts';
import { commitResult } from '../src/worker/results/database.ts';
import { readResults } from '../src/worker/results/read.ts';
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
    subjects.map((subject) => actorForSubject(organization.identityNamespace, subject)),
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
    rankedPlayers: 3,
    revision: instance.operationRevision,
    operationId: crypto.randomUUID(),
  };
  await saveCasualSettings(env, adminSubject, request);
  await saveCasualSettings(env, adminSubject, request);
  for (const rankedPlayers of [1, 5, 2.5])
    await assert.rejects(
      saveCasualSettings(env, adminSubject, {
        ...request,
        operationId: crypto.randomUUID(),
        rankedPlayers,
      }),
      /INVALID_SETUP/,
    );
  await assert.rejects(
    saveCasualSettings(env, adminSubject, { ...request, rankedPlayers: 2 }),
    /OPERATION_CONFLICT/,
  );
  const rankedVersions = await Promise.all(
    ['', '-band-0', '-band-1', '-band-2'].map((suffix) =>
      loadMatchDefinition({
        ...env,
        GAME_OWNER: instance.owner,
        GAME_CONFIG_PROFILE: `local${suffix}`,
      }),
    ),
  );
  await saveCasualSettings(env, adminSubject, {
    ...request,
    operationId: crypto.randomUUID(),
    revision: Number(request.revision) + 1,
    rankedPlayers: 2,
  });
  for (const [index, suffix] of ['', '-band-0', '-band-1', '-band-2'].entries()) {
    const fixed = rankedVersions[index];
    assert.equal(fixed.playersPerMatch, 3);
    const previous = await loadMatchDefinition(
      { ...env, GAME_OWNER: instance.owner, GAME_CONFIG_PROFILE: `local${suffix}` },
      fixed.competition,
    );
    assert.equal(previous.playersPerMatch, 3);
    const current = await loadMatchDefinition({
      ...env,
      GAME_OWNER: instance.owner,
      GAME_CONFIG_PROFILE: `local${suffix}`,
    });
    assert.equal(current.playersPerMatch, 2);
  }
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
  // The organization writer's RLS must see the active catalog before deciding to publish.
  await ensureCasualCatalog(env, instanceId);
  await ensureCasualCatalog(env, instanceId);
  const unchanged = await loadMatchDefinition({
    ...env,
    GAME_OWNER: instance.owner,
    GAME_CONFIG_PROFILE: 'local-casual',
  });
  assert.deepEqual(unchanged.competition, definition.competition);
  const organizationConnection = organizationDatabase(env);
  try {
    const data = await overview(
      organizationConnection.db,
      adminSubject,
      undefined,
      undefined,
      'local',
    );
    assert.equal(
      data.instances.find((candidateInstance) => candidateInstance.id === instanceId)
        ?.rankedPlayers,
      2,
    );
  } finally {
    await organizationConnection.close();
  }
  const categories = await roomOptions(env, instanceId);
  assert.deepEqual(
    categories.map((availableCategory) => availableCategory.id).sort(),
    (
      await db
        .select()
        .from(questionCategories)
        .where(eq(questionCategories.instanceId, instanceId))
    )
      .map((availableCategory) => availableCategory.id)
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
    (await personalSets(env, authorSubject)).filter(
      (questionSet) => questionSet.id === set.id,
    ).length,
    1,
  );
  assert.equal(
    (await personalSets(env, adminSubject)).some(
      (questionSet) => questionSet.id === set.id,
    ),
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
    (await personalSets(env, authorSubject)).some(
      (questionSet) => questionSet.id === set.id,
    ),
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
      players: record.players.map((participant) => ({ ...participant, correct: 4 })),
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
    (await history(env, identity)).history.some(
      (historyEntry) => historyEntry.resultId === old.result.id,
    ),
    false,
  );
  await commitResult(db, old);
  const indexed = await db
    .select()
    .from(resultPlayers)
    .where(eq(resultPlayers.resultId, old.result.id));
  assert.equal(
    indexed.find((indexedPlayer) => indexedPlayer.actorId === guest.actorId)?.name,
    'ゲスト',
  );
  const detail = await history(env, identity, {
    section: 'history',
    resultId: record.result.id,
  });
  assert.equal(detail.history.length, 1);
  assert.equal(detail.history[0].questions?.length, 1);
  assert.equal(
    (await history(env, identity, { section: 'history', resultId: old.result.id }))
      .history.length,
    0,
  );
  assert.equal(
    (
      await history(
        env,
        { ...identity, actor: { ...identity.actor, id: 'other-actor' } },
        { section: 'history', resultId: record.result.id },
      )
    ).history.length,
    0,
  );
  const tiedAt = Date.now();
  for (let i = 0; i < 26; i++) {
    const fixture = structuredClone(record);
    fixture.matchId = crypto.randomUUID();
    fixture.result.id = crypto.randomUUID();
    fixture.result.finishedAt = tiedAt;
    fixture.kind = i % 2 ? 'casual' : 'room';
    await commitResult(db, fixture);
  }
  const firstPage = await history(env, identity, { section: 'history' });
  assert.equal(firstPage.history.length, 20);
  assert.ok(firstPage.nextCursor);
  assert.ok(firstPage.history.every((entry) => entry.questions === undefined));
  assert.equal(firstPage.history[0].correct, 1);
  const nextQuery = { section: 'history' as const, cursor: firstPage.nextCursor };
  const nextPage = await history(env, identity, nextQuery);
  assert.deepEqual(await history(env, identity, nextQuery), nextPage);
  assert.equal(nextPage.history.length, 7);
  assert.equal(nextPage.nextCursor, null);
  assert.equal(
    new Set([...firstPage.history, ...nextPage.history].map((entry) => entry.resultId))
      .size,
    27,
  );
  const casualPage = await history(env, identity, { section: 'history', kind: 'casual' });
  assert.equal(casualPage.history.length, 13);
  assert.ok(casualPage.history.every((entry) => entry.kind === 'casual'));
  assert.deepEqual(
    (await history(env, author, { section: 'ranking' })).ranking,
    beforeRanking,
  );
  console.log(
    'PASS: history 20-item cursor pagination/ties/retry, kind filter, participant-only detail, guest deadline, list without question bodies, ranking isolation',
  );
  // Separate owner; 103 tied leaders and one participant outside the top 100.
  const rankingOwner = `urn:uuid:${crypto.randomUUID()}`;
  const selfActor = crypto.randomUUID();
  const leaders: string[] = [];
  for (let i = 0; i < 52; i++) {
    const fixture = structuredClone(record);
    fixture.owner = rankingOwner;
    fixture.kind = 'ranked';
    fixture.matchId = crypto.randomUUID();
    fixture.result.id = crypto.randomUUID();
    fixture.result.reason = i === 51 ? 'target_reached' : 'connections';
    fixture.definition.kind = 'ranked';
    delete fixture.definition.original;
    fixture.completedQuestions = [];
    for (const key of ['competition', 'ruleset', 'questionSet'] as const)
      fixture.definition[key].owner = rankingOwner;
    const first = crypto.randomUUID();
    const second = i === 51 ? selfActor : crypto.randomUUID();
    leaders.push(first);
    if (i !== 51) leaders.push(second);
    fixture.result.winnerId = i === 51 ? first : null;
    fixture.players = [
      { ...player(first, '上位者'), ratingDelta: 20 },
      { ...player(second, '参加者'), ratingDelta: i === 51 ? -20 : 20 },
    ];
    await commitResult(db, fixture);
  }
  const rankingReader = connectDatabase(roleUrl('quiz_game_reader'));
  try {
    const overview = await readResults(rankingReader.db, rankingOwner, selfActor, [], {
      section: 'ranking',
    });
    assert.equal(overview.ranking.length, 100);
    assert.ok(overview.ranking.every((row) => row.rank === 1));
    assert.ok(overview.ranking.every((row) => row.actorId !== selfActor));
    assert.deepEqual(overview.self, { rank: 104, rating: 980 });
    const selfOnly = await readResults(rankingReader.db, rankingOwner, selfActor, [], {
      section: 'self',
    });
    assert.deepEqual(selfOnly, { ranking: [], history: [], self: overview.self });
    assert.deepEqual(
      (
        await readResults(
          rankingReader.db,
          rankingOwner,
          selfActor,
          leaders.slice(0, 2),
          { section: 'self' },
        )
      ).self,
      { rank: 102, rating: 980 },
    );
    assert.deepEqual(
      (
        await readResults(rankingReader.db, rankingOwner, selfActor, [selfActor], {
          section: 'self',
        })
      ).self,
      { rank: null, rating: 980 },
    );
    for (const [owner, actor] of [
      [rankingOwner, crypto.randomUUID()],
      [record.owner, actors[1]], // room/casual results do not assign a rank
      ['https://unrelated-ranking.invalid', selfActor],
    ])
      assert.deepEqual(
        (await readResults(rankingReader.db, owner, actor, [], { section: 'self' })).self,
        { rank: null, rating: 1000 },
      );
  } finally {
    await rankingReader.close();
  }
  console.log(
    'PASS: self rank outside top 100, ties, exclusions without resetting rating, initial 1000, owner/nonrank isolation and real reader permissions',
  );
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
