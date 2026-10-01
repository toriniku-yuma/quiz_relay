import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { normalizeDisplayName } from '../../shared/profile.ts';
import type { BroughtQuestion, RoomSettings } from '../../shared/rooms.ts';
import { validateBroughtSet } from '../../shared/rooms.ts';
import type { FixedQuestion, MatchDefinition } from '../catalog/definition.ts';
import { contentHash } from '../catalog/hash.ts';
import {
  guestSessions,
  instanceDeletions,
  instances,
  matchmakingSettings,
  moderationRequests,
  organizations,
  personalQuestionSets,
  questionAvailability,
  questionCategories,
  questionSettings,
  questionSubmissions,
  questionVersions,
  roomDirectory,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { dummyCharacters } from '../game/questions.ts';
import { rules } from '../game/rules.ts';
import type { InstanceScope } from '../matchmaking/Matchmaker.ts';
import { OrganizationError, validId, validName } from '../organization/access.ts';
import {
  organizationDatabase,
  organizationIdentity,
  resolveInstance,
} from '../organization/database.ts';
import { requireUnrestricted } from '../organization/moderation.ts';
import { publishQuestionCatalog } from '../questions/catalog.ts';

export type Participant = { id: string; name: string; guest: boolean };
export const guestLifetime = 30 * 86400000;
export async function guestIdentity(env: Env, token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new OrganizationError('GUEST_REQUIRED', 403);
  const { db, close } = organizationDatabase(env);
  try {
    const [guest] = await db
      .select()
      .from(guestSessions)
      .where(
        and(
          eq(guestSessions.actorId, await contentHash(token)),
          gt(guestSessions.expiresAt, new Date().toISOString()),
        ),
      );
    if (!guest) throw new OrganizationError('GUEST_REQUIRED', 403);
    return guest;
  } finally {
    await close();
  }
}
export async function createGuest(
  env: Env,
  input: Record<string, unknown>,
  token: string,
) {
  const { name } = input;
  const operationId = validId(input.operationId),
    hash = await contentHash(input);
  const normalized = normalizeDisplayName(name);
  if (!normalized || normalized.length > 24)
    throw new OrganizationError('INVALID_NAME', 400);
  const { db, close } = organizationDatabase(env);
  try {
    const [organization] = await db.select().from(organizations);
    if (!organization) throw new OrganizationError('SETUP_REQUIRED', 409);
    if (!/^[0-9a-f]{64}$/.test(token)) throw new OrganizationError('GUEST_REQUIRED', 403);
    const actorId = await contentHash(token);
    const expiresAt = new Date(Date.now() + guestLifetime).toISOString();
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`guest:${actorId}`},0))`,
      );
      const [previous] = await tx
        .select()
        .from(moderationRequests)
        .where(eq(moderationRequests.id, operationId));
      if (previous) {
        if (previous.operatorId !== actorId || previous.requestHash !== hash)
          throw new OrganizationError('OPERATION_CONFLICT', 409);
        return;
      }
      await tx
        .insert(guestSessions)
        .values({ actorId, organizationId: organization.id, name: normalized, expiresAt })
        .onConflictDoUpdate({
          target: guestSessions.actorId,
          set: { name: normalized, expiresAt },
        });
      await tx.insert(moderationRequests).values({
        id: operationId,
        organizationId: organization.id,
        operatorId: actorId,
        requestHash: hash,
        details: { action: 'guestName' },
      });
    });
    return { token, actorId, name: normalized };
  } finally {
    await close();
  }
}
export async function publicInstances(env: Env) {
  const { db, close } = organizationDatabase(env);
  try {
    return (await db.select().from(instances).where(eq(instances.state, 'published')))
      .filter((i) => i.casualConfig.casualGuests || i.casualConfig.roomGuests)
      .map((i) => ({
        id: i.id,
        name: i.name,
        casualConfig: i.casualConfig,
        casualPauseReason: i.casualPauseReason,
      }));
  } finally {
    await close();
  }
}
export async function participantContext(
  env: Env,
  instanceId: string,
  mode: 'casual' | 'room',
  subject?: string,
  guestToken?: string,
  existing = false,
  creating = false,
) {
  const { db, close } = organizationDatabase(env);
  try {
    let actor: Participant;
    let instance: typeof instances.$inferSelect;
    let privileged = false;
    if (subject) {
      const identity = await resolveInstance(db, subject, instanceId, true);
      instance = identity.instance;
      actor = {
        id: identity.account.actorId,
        name: identity.account.displayName ?? '',
        guest: false,
      };
      privileged = identity.account.administrator || identity.permissions.length > 0;
      if (!existing)
        await requireUnrestricted(
          db,
          instance.organizationId,
          actor.id,
          instance.id,
          'casual',
        );
      if (creating)
        await requireUnrestricted(
          db,
          instance.organizationId,
          actor.id,
          instance.id,
          'rooms',
        );
    } else {
      const guest = await guestIdentity(env, guestToken ?? '');
      const [row] = await db
        .select()
        .from(instances)
        .where(
          and(
            eq(instances.id, validId(instanceId)),
            eq(instances.organizationId, guest.organizationId),
          ),
        );
      if (!row) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
      instance = row;
      actor = { id: guest.actorId, name: guest.name, guest: true };
      if (creating) throw new OrganizationError('LOGIN_REQUIRED', 403);
    }
    if (!existing) {
      if (instance.state === 'archived')
        throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
      if (!privileged && instance.state !== 'published')
        throw new OrganizationError('INSTANCE_PREPARING', 409);
      if (!privileged && instance.casualPauseReason)
        throw new OrganizationError('CASUAL_PAUSED', 409);
      if (mode === 'casual' && !instance.casualConfig.enabled)
        throw new OrganizationError('CASUAL_DISABLED', 409);
      if (
        actor.guest &&
        !(mode === 'casual'
          ? instance.casualConfig.casualGuests
          : instance.casualConfig.roomGuests)
      )
        throw new OrganizationError('GUEST_NOT_ALLOWED', 403);
    }
    return {
      actor,
      instance,
      scope: { id: instance.id, owner: instance.owner, mode } satisfies InstanceScope,
    };
  } finally {
    await close();
  }
}

export async function previewInstance(env: Env, instanceId: string, subject?: string) {
  const { db, close } = organizationDatabase(env);
  try {
    if (subject) return (await resolveInstance(db, subject, instanceId, true)).instance;
    const [instance] = await db
      .select()
      .from(instances)
      .where(
        and(eq(instances.id, validId(instanceId)), eq(instances.state, 'published')),
      );
    if (!instance) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    return instance;
  } finally {
    await close();
  }
}

export async function ensureCasualCatalog(env: Env, instanceId: string) {
  const { db, close } = organizationDatabase(env);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${instanceId}`},0))`,
      );
      const [instance] = await tx
        .select()
        .from(instances)
        .where(eq(instances.id, instanceId));
      if (
        !instance ||
        instance.state === 'archived' ||
        (
          await tx
            .select()
            .from(instanceDeletions)
            .where(eq(instanceDeletions.instanceId, instanceId))
        ).length
      )
        throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
      const [active] = await tx
        .select()
        .from(matchmakingSettings)
        .where(
          and(
            eq(matchmakingSettings.owner, instance.owner),
            eq(matchmakingSettings.profile, `${env.GAME_CONFIG_PROFILE}-casual`),
          ),
        );
      if (active) return;
      await tx.execute(
        sql`select set_config('quiz.organization_id',${instance.organizationId},true)`,
      );
      await publishQuestionCatalog(
        tx,
        instanceId,
        instance.owner,
        env.GAME_CONFIG_PROFILE,
      );
    });
  } finally {
    await close();
  }
}

export async function personalSets(env: Env, subject: string) {
  const { db, close } = organizationDatabase(env);
  try {
    const { account, organization } = await organizationIdentity(db, subject);
    return await db
      .select()
      .from(personalQuestionSets)
      .where(
        and(
          eq(personalQuestionSets.organizationId, organization.id),
          eq(personalQuestionSets.authorId, account.actorId),
        ),
      )
      .orderBy(asc(personalQuestionSets.name), asc(personalQuestionSets.id));
  } finally {
    await close();
  }
}
export async function mutatePersonalSet(
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  const id = validId(input.id),
    operationId = validId(input.operationId),
    hash = await contentHash(input);
  const { db, close } = organizationDatabase(env);
  try {
    return await db.transaction(async (tx) => {
      const initial = await organizationIdentity(tx, subject);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`profile:${initial.organization.id}`},0))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`personal:${id}`},0))`,
      );
      const { account, organization } = await organizationIdentity(tx, subject);
      const [previous] = await tx
        .select()
        .from(moderationRequests)
        .where(eq(moderationRequests.id, operationId));
      if (previous) {
        if (previous.operatorId !== account.actorId || previous.requestHash !== hash)
          throw new OrganizationError('OPERATION_CONFLICT', 409);
        return { ok: true, id };
      }
      const [current] = await tx
        .select()
        .from(personalQuestionSets)
        .where(eq(personalQuestionSets.id, id));
      if (
        (current && current.authorId !== account.actorId) ||
        (current?.revision ?? 0) !== input.revision
      )
        throw new OrganizationError('EDIT_CONFLICT', 409);
      if (input.action === 'save') {
        const questions = validateBroughtSet(input.questions),
          name = validName(input.name);
        await tx
          .insert(personalQuestionSets)
          .values({
            id,
            organizationId: organization.id,
            authorId: account.actorId,
            questions,
            name,
          })
          .onConflictDoUpdate({
            target: personalQuestionSets.id,
            set: {
              name,
              questions,
              revision: (current?.revision ?? 0) + 1,
              updatedAt: new Date().toISOString(),
            },
          });
      } else if (input.action === 'delete' && current)
        await tx.delete(personalQuestionSets).where(eq(personalQuestionSets.id, id));
      else throw new OrganizationError('INVALID_OPERATION', 400);
      await tx.insert(moderationRequests).values({
        id: operationId,
        organizationId: organization.id,
        operatorId: account.actorId,
        requestHash: hash,
        details: { action: 'personalSet', setId: id },
      });
      return { ok: true, id };
    });
  } finally {
    await close();
  }
}
export async function roomIds(env: Env, instanceId: string) {
  const { db, close } = organizationDatabase(env);
  try {
    return await db
      .select()
      .from(roomDirectory)
      .where(
        and(
          eq(roomDirectory.instanceId, validId(instanceId)),
          eq(roomDirectory.public, true),
          eq(roomDirectory.closed, false),
        ),
      );
  } finally {
    await close();
  }
}
export async function roomOptions(env: Env, instanceId: string) {
  const { db, close } = organizationDatabase(env);
  try {
    return await db.transaction(async (tx) => {
      const [instance] = await tx
        .select()
        .from(instances)
        .where(eq(instances.id, instanceId));
      if (!instance) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
      await tx.execute(
        sql`select set_config('quiz.organization_id',${instance.organizationId},true)`,
      );
      return tx
        .select()
        .from(questionCategories)
        .where(eq(questionCategories.instanceId, instanceId));
    });
  } finally {
    await close();
  }
}
export async function publishRoom(
  env: Env,
  id: string,
  instanceId: string,
  publicRoom: boolean,
  closed: boolean,
) {
  const { db, close } = organizationDatabase(env);
  try {
    await db
      .insert(roomDirectory)
      .values({ id, instanceId, public: publicRoom, closed })
      .onConflictDoUpdate({
        target: roomDirectory.id,
        set: { public: publicRoom, closed },
      });
  } finally {
    await close();
  }
}
export async function roomDefinition(
  env: Env,
  scope: InstanceScope,
  settings: RoomSettings,
  original: BroughtQuestion[],
  sourceId: string,
): Promise<MatchDefinition> {
  let questions: FixedQuestion[];
  if (settings.source === 'original') {
    questions = validateBroughtSet(original).map((q, index) => ({
      ...q,
      id: `original-${sourceId}-${index}`,
      version: 1,
      answer: q.readings[0],
      distractors: [...dummyCharacters],
      source: '',
      permission: '部屋用持込',
      demoAllowed: true,
    }));
  } else {
    const { db, close } = organizationDatabase(env);
    try {
      questions = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${scope.id}`},0))`,
        );
        const [instance] = await tx
          .select()
          .from(instances)
          .where(and(eq(instances.id, scope.id), eq(instances.owner, scope.owner)));
        if (!instance || instance.state === 'archived')
          throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
        await tx.execute(
          sql`select set_config('quiz.organization_id',${instance.organizationId},true)`,
        );
        const [configuration] = await tx
          .select()
          .from(questionSettings)
          .where(eq(questionSettings.instanceId, scope.id));
        const rows = await tx
          .select({
            q: questionVersions.payload,
            authorName: sql<string>`coalesce(${questionSubmissions.provenance}->>'author', ${questionSubmissions.authorName})`,
          })
          .from(questionSubmissions)
          .innerJoin(
            questionVersions,
            and(
              eq(questionVersions.owner, scope.owner),
              eq(
                questionVersions.questionId,
                sql`${questionSubmissions.publishedId}::text`,
              ),
            ),
          )
          .innerJoin(
            questionAvailability,
            and(
              eq(questionAvailability.owner, scope.owner),
              eq(questionAvailability.questionId, questionVersions.questionId),
            ),
          )
          .where(
            and(
              eq(questionSubmissions.instanceId, scope.id),
              sql`${questionAvailability.retiredAt} IS NULL`,
            ),
          );
        return rows
          .map((r) => ({
            ...r.q,
            ...(configuration?.config.showAuthor ? { authorName: r.authorName } : {}),
          }))
          .filter(
            (q) =>
              (settings.categories.length === 0 ||
                settings.categories.includes(q.categoryId ?? '')) &&
              settings.difficulties.includes(q.difficulty ?? 0),
          );
      });
    } finally {
      await close();
    }
  }
  if (!questions.length) throw new OrganizationError('NO_ROOM_QUESTIONS', 409);
  const fixedRules = {
    ...rules,
    showSelections: true,
    winMode: settings.winMode,
    questionLimit: settings.count,
    correctAnswersToWin: settings.count,
    mistakesToDisqualify: settings.mistakes ?? 3,
    noDisqualification: settings.mistakes === null,
  };
  const reference = { owner: scope.owner, id: `room-${sourceId}`, version: 1 };
  return {
    kind: 'room',
    original: settings.source === 'original',
    competition: reference,
    ruleset: reference,
    questionSet: reference,
    rulesHash: await contentHash(fixedRules),
    manifestHash: await contentHash(questions),
    playersPerMatch: settings.capacity,
    rules: fixedRules,
    questions,
  };
}
export async function saveCasualSettings(
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  const id = validId(input.id),
    operationId = validId(input.operationId),
    hash = await contentHash(input);
  const config = input.config as typeof instances.$inferSelect.casualConfig;
  if (
    !config ||
    Object.keys(config).sort().join(',') !== 'casualGuests,enabled,players,roomGuests' ||
    !['enabled', 'casualGuests', 'roomGuests'].every(
      (k) => typeof config[k as keyof typeof config] === 'boolean',
    ) ||
    !Number.isInteger(config.players) ||
    config.players < 2 ||
    config.players > 4
  )
    throw new OrganizationError('INVALID_SETUP', 400);
  const { db, close } = organizationDatabase(env);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${id}`},0))`,
      );
      const identity = await resolveInstance(tx, subject, id, true);
      if (!identity.account.administrator) throw new OrganizationError('ADMIN_REQUIRED');
      const [previous] = await tx
        .select()
        .from(moderationRequests)
        .where(eq(moderationRequests.id, operationId));
      if (previous) {
        if (
          previous.operatorId !== identity.account.actorId ||
          previous.requestHash !== hash
        )
          throw new OrganizationError('OPERATION_CONFLICT', 409);
        return { ok: true };
      }
      if (
        (
          await tx
            .select()
            .from(instanceDeletions)
            .where(eq(instanceDeletions.instanceId, id))
        ).length
      )
        throw new OrganizationError('INSTANCE_DELETING', 409);
      if (
        identity.instance.operationRevision !== input.revision ||
        identity.instance.state === 'archived'
      )
        throw new OrganizationError('EDIT_CONFLICT', 409);
      await tx
        .update(instances)
        .set({
          casualConfig: config,
          operationRevision: identity.instance.operationRevision + 1,
        })
        .where(eq(instances.id, id));
      await tx.execute(
        sql`select set_config('quiz.organization_id',${identity.organization.id},true)`,
      );
      await publishQuestionCatalog(
        tx,
        id,
        identity.instance.owner,
        env.GAME_CONFIG_PROFILE,
      );
      await tx.insert(moderationRequests).values({
        id: operationId,
        organizationId: identity.organization.id,
        operatorId: identity.account.actorId,
        requestHash: hash,
        details: {
          id,
          action: 'casualConfig',
          before: identity.instance.casualConfig,
          after: config,
        },
      });
      return { ok: true };
    });
  } finally {
    await close();
  }
}
