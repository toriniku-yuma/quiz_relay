import { and, asc, eq, exists, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { blocks } from '../../shared/moderation.ts';
import {
  type InstancePermission,
  instancePermissions,
  type OrganizationOverview,
  permissionRevision,
} from '../../shared/organization.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, connectD1, type Database, readD1 } from '../db/d1.ts';
import {
  accountInstanceSelections,
  organizationAccounts as accounts,
  competitions,
  instanceGrants as grants,
  guestSessions,
  instanceDeletions,
  instances,
  matchmakingSettings,
  moderationRequests,
  moderationSanctions,
  organizationEvents,
  organizations,
  questionSubmissions,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { federationAllowedActors } from '../federation/admission.ts';
import {
  actorForSubject,
  canViewInstance,
  OrganizationError,
  requireAdministrator,
  requireInstaller,
  validId,
  validName,
} from './access.ts';

export function organizationDatabase(env: Env) {
  if (!env.GAME_D1) throw new OrganizationError('ORGANIZATION_UNAVAILABLE', 503);
  return { db: connectD1(env.GAME_D1), close: async () => {} };
}

function audit(
  db: Database,
  actorId: string,
  action: typeof organizationEvents.$inferInsert.action,
  instanceId: string | null,
  details: Record<string, unknown> = {},
) {
  return db
    .insert(organizationEvents)
    .values({ id: crypto.randomUUID(), actorId, action, instanceId, details });
}

export async function organizationIdentity(
  db: Database,
  subject: string,
  known?: typeof organizations.$inferSelect,
  allowWithdrawn = false,
) {
  const organization = known ?? (await db.select().from(organizations))[0];
  if (!organization) throw new OrganizationError('SETUP_REQUIRED', 409);
  const actorId = await actorForSubject(organization.identityNamespace, subject);
  let [account] = await db
    .select()
    .from(accounts)
    .where(
      and(eq(accounts.organizationId, organization.id), eq(accounts.subject, subject)),
    );
  if (!account) {
    await changeD1(db, async (writes) => {
      writes.push(
        db
          .insert(accounts)
          .values({ organizationId: organization.id, subject, actorId })
          .onConflictDoNothing(),
      );
    });
    [account] = await db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.organizationId, organization.id), eq(accounts.subject, subject)),
      );
  }
  if (!account || account.actorId !== actorId)
    throw new OrganizationError('IDENTITY_CONFLICT', 409);
  if (account.withdrawnAt && !allowWithdrawn)
    throw new OrganizationError('ACCOUNT_WITHDRAWN', 403);
  return { organization, account };
}

async function readOverview(
  db: Database,
  subject: string,
  initialSubject?: string,
  accountCursor?: string,
  profile = 'default',
): Promise<OrganizationOverview> {
  if (
    accountCursor !== undefined &&
    (typeof accountCursor !== 'string' || !/^[0-9a-f]{64}$/.test(accountCursor))
  )
    throw new OrganizationError('INVALID_ACCOUNT', 400);
  const [existing] = await db.select().from(organizations);
  if (!existing)
    return {
      setup: { subject, eligible: !!initialSubject && subject === initialSubject },
      instances: [],
    };
  const { organization, account } = await organizationIdentity(db, subject, existing);
  const authored = await db
    .selectDistinct({ id: questionSubmissions.instanceId })
    .from(questionSubmissions)
    .where(eq(questionSubmissions.authorId, account.actorId));
  const all = await db
    .select()
    .from(instances)
    .where(
      and(
        eq(instances.organizationId, organization.id),
        account.administrator
          ? undefined
          : or(
              eq(instances.state, 'published'),
              authored.length
                ? and(
                    eq(instances.state, 'archived'),
                    sql`${instances.id} in (select value from json_each(${JSON.stringify(authored.map((row) => row.id))}))`,
                  )
                : undefined,
              exists(
                db
                  .select()
                  .from(grants)
                  .where(
                    and(
                      eq(grants.instanceId, instances.id),
                      eq(grants.actorId, account.actorId),
                    ),
                  ),
              ),
            ),
      ),
    );
  const playerCounts = all.length
    ? await db
        .select({ owner: competitions.owner, players: competitions.playersPerMatch })
        .from(matchmakingSettings)
        .innerJoin(
          competitions,
          and(
            eq(competitions.owner, matchmakingSettings.owner),
            eq(competitions.competitionId, matchmakingSettings.competitionId),
            eq(competitions.version, matchmakingSettings.competitionVersion),
          ),
        )
        .where(
          and(
            sql`${matchmakingSettings.owner} in (select value from json_each(${JSON.stringify(all.map((instance) => instance.owner))}))`,
            eq(matchmakingSettings.profile, profile),
          ),
        )
    : [];
  const permissions = await db
    .select()
    .from(grants)
    .where(eq(grants.actorId, account.actorId));
  const selections = await db
    .select({ id: accountInstanceSelections.instanceId })
    .from(accountInstanceSelections)
    .where(eq(accountInstanceSelections.actorId, account.actorId));
  const sanctions = await db
    .select({
      id: moderationSanctions.id,
      instanceId: moderationSanctions.instanceId,
      actorId: moderationSanctions.actorId,
      kind: moderationSanctions.kind,
      restrictions: moderationSanctions.restrictions,
      reason: moderationSanctions.reason,
      expiresAt: moderationSanctions.expiresAt,
      revokedAt: moderationSanctions.revokedAt,
      revision: moderationSanctions.revision,
    })
    .from(moderationSanctions)
    .where(
      and(
        eq(moderationSanctions.organizationId, organization.id),
        eq(moderationSanctions.actorId, account.actorId),
        isNull(moderationSanctions.revokedAt),
        or(
          isNull(moderationSanctions.expiresAt),
          gt(moderationSanctions.expiresAt, new Date().toISOString()),
        ),
      ),
    );
  if (accountCursor !== undefined && !/^[0-9a-f]{64}$/.test(accountCursor))
    throw new OrganizationError('INVALID_ACCOUNT', 400);
  const accountPage = account.administrator
    ? await db
        .select({ actorId: accounts.actorId, administrator: accounts.administrator })
        .from(accounts)
        .where(
          and(
            eq(accounts.organizationId, organization.id),
            accountCursor ? gt(accounts.actorId, accountCursor) : undefined,
          ),
        )
        .orderBy(asc(accounts.actorId))
        .limit(101)
    : [];
  return {
    organization: { id: organization.id, name: organization.name },
    account: {
      actorId: account.actorId,
      administrator: account.administrator,
      displayName: account.displayName,
      profileRevision: account.profileRevision,
    },
    addedInstanceIds: selections.map((selection) => selection.id),
    sanctions,
    instances: all
      .map((instance) => ({
        id: instance.id,
        name: instance.name,
        state: instance.state,
        operationRevision: instance.operationRevision,
        pauseReason: instance.pauseReason,
        rankedPauseReason: instance.rankedPauseReason,
        casualPauseReason: instance.casualPauseReason,
        casualConfig: instance.casualConfig,
        rankedPlayers:
          playerCounts.find((row) => row.owner === instance.owner)?.players ?? 4,
        hasOwnQuestions: authored.some((row) => row.id === instance.id),
        permissions: permissions
          .filter((grant) => grant.instanceId === instance.id)
          .map((grant) => grant.permission),
      }))
      .filter(
        (instance) =>
          instance.state === 'archived' ||
          canViewInstance(instance.state, account.administrator, instance.permissions),
      ),
    ...(account.administrator
      ? {
          accounts: accountPage.slice(0, 100),
          nextAccountCursor:
            accountPage.length > 100 ? accountPage[99].actorId : undefined,
        }
      : {}),
  };
}

export async function overview(
  db: Database,
  subject: string,
  initialSubject?: string,
  accountCursor?: string,
  profile = 'default',
): Promise<OrganizationOverview> {
  return readD1(db, () =>
    readOverview(db, subject, initialSubject, accountCursor, profile),
  );
}

export async function setupOrganization(
  db: Database,
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  requireInstaller(subject, env.INITIAL_ADMIN_SUBJECT);
  const name = validName(input.name),
    instanceName = validName(input.instanceName);
  return changeD1(db, async (writes) => {
    if ((await db.select().from(organizations)).length)
      throw new OrganizationError('ALREADY_CONFIGURED', 409);
    const id = crypto.randomUUID(),
      instanceId = crypto.randomUUID();
    const identityNamespace = `urn:uuid:${id}`;
    const actorId = await actorForSubject(identityNamespace, subject);
    writes.push(
      db.insert(organizations).values({ id, name, identityNamespace }),
      db
        .insert(accounts)
        .values({ organizationId: id, subject, actorId, administrator: true }),
      db.insert(instances).values({
        id: instanceId,
        organizationId: id,
        owner: `urn:uuid:${instanceId}`,
        name: instanceName,
        roomInventoryComplete: true,
      }),
      audit(db, actorId, 'setup', instanceId, { name, instanceName }),
    );
  });
}

export async function addInstance(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const id = validId(input.id),
    name = validName(input.name);
  await changeD1(db, async (writes) => {
    const { organization, account } = await organizationIdentity(db, subject);
    requireAdministrator(account);
    const [existing] = await db.select().from(instances).where(eq(instances.id, id));
    if (existing) {
      if (
        existing.organizationId !== organization.id ||
        existing.owner !== `urn:uuid:${id}`
      )
        throw new OrganizationError('INSTANCE_CONFLICT', 409);
      return;
    }
    writes.push(
      db.insert(instances).values({
        id,
        organizationId: organization.id,
        owner: `urn:uuid:${id}`,
        name,
        roomInventoryComplete: true,
      }),
      audit(db, account.actorId, 'add', id, { name }),
    );
  });
}

export async function publishInstance(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const id = validId(input.id);
  await changeD1(db, async (writes) => {
    const { organization, account } = await organizationIdentity(db, subject);
    requireAdministrator(account);
    const [instance] = await db
      .select()
      .from(instances)
      .where(and(eq(instances.id, id), eq(instances.organizationId, organization.id)));
    if (!instance || instance.state === 'archived')
      throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    writes.push(
      db
        .update(instances)
        .set({
          state: 'published',
          pauseReason: null,
          operationRevision: instance.operationRevision + 1,
        })
        .where(eq(instances.id, id)),
      audit(db, account.actorId, 'publish', id, {}),
    );
  });
}

export async function resolveInstance(
  db: Database,
  subject: string,
  id: string,
  existingParticipation = false,
) {
  validId(id);
  const identity = await organizationIdentity(db, subject);
  const [instance] = await db
    .select()
    .from(instances)
    .where(
      and(
        eq(instances.id, validId(id)),
        eq(instances.organizationId, identity.organization.id),
      ),
    );
  if (!instance) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
  const permissions = (
    await db
      .select()
      .from(grants)
      .where(and(eq(grants.instanceId, id), eq(grants.actorId, identity.account.actorId)))
  ).map((row) => row.permission);
  if (
    !existingParticipation &&
    !canViewInstance(instance.state, identity.account.administrator, permissions)
  )
    throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
  return { ...identity, instance, permissions };
}

export async function setInstanceSelection(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const id = validId(input.id);
  if (typeof input.added !== 'boolean')
    throw new OrganizationError('INVALID_OPERATION', 400);
  await changeD1(db, async (writes) => {
    const { account } = input.added
      ? await resolveInstance(db, subject, id)
      : await organizationIdentity(db, subject);
    if (account.withdrawnAt) throw new OrganizationError('ACCOUNT_WITHDRAWN', 403);
    writes.push(
      input.added
        ? db
            .insert(accountInstanceSelections)
            .values({ actorId: account.actorId, instanceId: id })
            .onConflictDoNothing()
        : db
            .delete(accountInstanceSelections)
            .where(
              and(
                eq(accountInstanceSelections.actorId, account.actorId),
                eq(accountInstanceSelections.instanceId, id),
              ),
            ),
    );
  });
  return { ok: true };
}

export async function setInstanceGrants(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const id = validId(input.id);
  if (
    typeof input.actorId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.actorId) ||
    typeof input.expected !== 'string' ||
    input.expected.length > 64 ||
    !Array.isArray(input.permissions) ||
    input.permissions.length > instancePermissions.length ||
    input.permissions.some((permission) => !instancePermissions.includes(permission)) ||
    new Set(input.permissions).size !== input.permissions.length
  )
    throw new OrganizationError('INVALID_PERMISSION', 400);
  const actorId = input.actorId,
    permissions = input.permissions as InstancePermission[];
  await changeD1(db, async (writes) => {
    const { organization, account } = await organizationIdentity(db, subject);
    requireAdministrator(account);
    const [instance] = await db
      .select()
      .from(instances)
      .where(and(eq(instances.id, id), eq(instances.organizationId, organization.id)));
    const [target] = await db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.actorId, actorId), eq(accounts.organizationId, organization.id)),
      );
    if (!instance || !target) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    if (target.withdrawnAt) throw new OrganizationError('ACCOUNT_WITHDRAWN', 409);
    const previous = await db
      .select({ permission: grants.permission })
      .from(grants)
      .where(and(eq(grants.instanceId, id), eq(grants.actorId, actorId)));
    if (input.expected !== permissionRevision(previous.map((row) => row.permission)))
      throw new OrganizationError('EDIT_CONFLICT', 409);
    writes.push(
      db
        .delete(grants)
        .where(and(eq(grants.instanceId, id), eq(grants.actorId, actorId))),
    );
    if (permissions.length)
      writes.push(
        db
          .insert(grants)
          .values(
            permissions.map((permission) => ({ instanceId: id, actorId, permission })),
          ),
      );
    writes.push(
      audit(db, account.actorId, 'grants', id, {
        target: actorId,
        before: previous.map((row) => row.permission),
        after: permissions,
      }),
    );
  });
}

export async function renameOrganization(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const expected = validName(input.expectedName),
    name = validName(input.name);
  await changeD1(db, async (writes) => {
    const { organization, account } = await organizationIdentity(db, subject);
    requireAdministrator(account);
    // Retrying a saved request must not create another audit entry.
    if (organization.name === name) return;
    if (organization.name !== expected) throw new OrganizationError('EDIT_CONFLICT', 409);
    writes.push(
      db
        .update(organizations)
        .set({ name, federationRevision: organization.federationRevision + 1 })
        .where(eq(organizations.id, organization.id)),
      audit(db, account.actorId, 'rename', null, { before: expected, after: name }),
    );
  });
}

export async function renameInstance(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const expected = validName(input.expectedName),
    id = validId(input.id),
    name = validName(input.name);
  await changeD1(db, async (writes) => {
    const { organization, account } = await organizationIdentity(db, subject);
    requireAdministrator(account);
    if (
      (
        await db
          .select()
          .from(instanceDeletions)
          .where(eq(instanceDeletions.instanceId, id))
      ).length
    )
      throw new OrganizationError('INSTANCE_DELETING', 409);
    const [instance] = await db
      .select()
      .from(instances)
      .where(
        and(
          eq(instances.id, id),
          eq(instances.name, expected),
          eq(instances.organizationId, organization.id),
        ),
      );
    if (!instance) throw new OrganizationError('EDIT_CONFLICT', 409);
    writes.push(
      db.update(instances).set({ name }).where(eq(instances.id, id)),
      audit(db, account.actorId, 'rename', id, { before: expected, after: name }),
    );
  });
}

export async function accountPermissions(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
): Promise<OrganizationOverview> {
  const id = validId(input.id);
  if (typeof input.actorId !== 'string' || !/^[0-9a-f]{64}$/.test(input.actorId))
    throw new OrganizationError('INVALID_ACCOUNT', 400);
  const { organization, account } = await organizationIdentity(db, subject);
  requireAdministrator(account);
  const [instance] = await db
    .select()
    .from(instances)
    .where(and(eq(instances.id, id), eq(instances.organizationId, organization.id)));
  const [target] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organization.id),
        eq(accounts.actorId, input.actorId),
      ),
    );
  if (!instance || !target) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
  const permissions = await db
    .select()
    .from(grants)
    .where(and(eq(grants.instanceId, id), eq(grants.actorId, target.actorId)));
  return {
    instances: [],
    accounts: [{ actorId: target.actorId, administrator: target.administrator }],
    grants: permissions,
  };
}

export async function changeInstanceOperation(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const id = validId(input.id),
    operationId = validId(input.operationId);
  const action = String(input.action);
  if (
    ![
      'publish',
      'prepare',
      'stopRanked',
      'resumeRanked',
      'stopCasual',
      'resumeCasual',
      'archive',
      'restore',
    ].includes(action) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 0
  )
    throw new OrganizationError('INVALID_OPERATION', 400);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (
    ['prepare', 'stopRanked', 'stopCasual'].includes(action) &&
    (!reason || reason.length > 1000)
  )
    throw new OrganizationError('REASON_REQUIRED', 400);
  const hash = await contentHash(input);
  return changeD1(db, async (writes) => {
    const { organization, account } = await organizationIdentity(db, subject);
    requireAdministrator(account);
    const [previous] = await db
      .select()
      .from(moderationRequests)
      .where(eq(moderationRequests.id, operationId));
    if (previous) {
      if (previous.operatorId !== account.actorId || previous.requestHash !== hash)
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return { organizationId: organization.id };
    }
    const [instance] = await db
      .select()
      .from(instances)
      .where(and(eq(instances.id, id), eq(instances.organizationId, organization.id)));
    if (!instance) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    if (
      (
        await db
          .select()
          .from(instanceDeletions)
          .where(eq(instanceDeletions.instanceId, id))
      ).length
    )
      throw new OrganizationError('INSTANCE_DELETING', 409);
    if (
      (action === 'restore'
        ? instance.state !== 'archived'
        : instance.state === 'archived') ||
      instance.operationRevision !== input.revision
    )
      throw new OrganizationError('EDIT_CONFLICT', 409);
    writes.push(
      db
        .update(instances)
        .set({
          operationRevision: instance.operationRevision + 1,
          ...(action === 'archive' ? { state: 'archived' as const } : {}),
          ...(action === 'restore' ? { state: 'preparing' as const } : {}),
          ...(action === 'publish'
            ? { state: 'published' as const, pauseReason: null }
            : {}),
          ...(action === 'prepare'
            ? { state: 'preparing' as const, pauseReason: reason }
            : {}),
          ...(action === 'stopRanked' ? { rankedPauseReason: reason } : {}),
          ...(action === 'resumeRanked' ? { rankedPauseReason: null } : {}),
          ...(action === 'stopCasual' ? { casualPauseReason: reason } : {}),
          ...(action === 'resumeCasual' ? { casualPauseReason: null } : {}),
        })
        .where(eq(instances.id, id)),
      db.insert(moderationRequests).values({
        id: operationId,
        organizationId: organization.id,
        operatorId: account.actorId,
        requestHash: hash,
        details: input,
      }),
    );
    return { organizationId: organization.id };
  });
}

// Called with server-owned room scope and participant IDs, never browser-supplied actor IDs.
export async function allowedInstanceActors(
  env: Env,
  scope: { id: string; owner: string; mode?: 'casual' | 'room' },
  actors: string[],
  matchId?: string,
  pendingActors: string[] = [],
): Promise<string[]> {
  if (!actors.length) return [];
  const { db, close } = organizationDatabase(env);
  try {
    const rows = await db
      .select({ actorId: accounts.actorId })
      .from(accounts)
      .innerJoin(instances, eq(instances.organizationId, accounts.organizationId))
      .where(
        and(
          eq(instances.id, scope.id),
          eq(instances.owner, scope.owner),
          inArray(accounts.actorId, actors),
          sql`${accounts.withdrawnAt} IS NULL`,
          sql`${instances.state} <> 'archived'`,
          or(
            and(
              eq(instances.state, 'published'),
              scope.mode
                ? sql`${instances.casualPauseReason} IS NULL`
                : sql`${instances.rankedPauseReason} IS NULL`,
            ),
            eq(accounts.administrator, true),
            exists(
              db
                .select()
                .from(grants)
                .where(
                  and(
                    eq(grants.instanceId, instances.id),
                    eq(grants.actorId, accounts.actorId),
                  ),
                ),
            ),
          ),
        ),
      );
    const restrictions = await db
      .select()
      .from(moderationSanctions)
      .where(
        and(
          inArray(moderationSanctions.actorId, actors),
          or(
            eq(moderationSanctions.instanceId, scope.id),
            sql`${moderationSanctions.instanceId} IS NULL`,
          ),
        ),
      );
    const allowed = await federationAllowedActors(
      db,
      scope,
      rows
        .map((row) => row.actorId)
        .filter(
          (id) =>
            !restrictions.some(
              (row) =>
                row.actorId === id && blocks(row, scope.mode ? 'casual' : 'ranked'),
            ),
        ),
      matchId,
      pendingActors,
    );
    if (!scope.mode) return allowed;
    const [instance] = await db
      .select()
      .from(instances)
      .where(and(eq(instances.id, scope.id), eq(instances.owner, scope.owner)));
    if (!instance || (scope.mode === 'casual' && !instance.casualConfig.enabled))
      return [];
    if (
      instance.state === 'published' &&
      !instance.casualPauseReason &&
      (scope.mode === 'casual'
        ? instance.casualConfig.casualGuests
        : instance.casualConfig.roomGuests)
    ) {
      const guests = await db
        .select()
        .from(guestSessions)
        .where(
          and(
            inArray(guestSessions.actorId, actors),
            eq(guestSessions.organizationId, instance.organizationId),
            gt(guestSessions.expiresAt, new Date().toISOString()),
          ),
        );
      allowed.push(...guests.map((guest) => guest.actorId));
    }
    return allowed;
  } finally {
    await close();
  }
}
