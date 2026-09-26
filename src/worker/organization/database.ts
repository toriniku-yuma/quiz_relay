import { and, asc, eq, exists, gt, inArray, or, sql } from 'drizzle-orm';
import {
  type InstancePermission,
  instancePermissions,
  type OrganizationOverview,
  permissionRevision,
} from '../../shared/organization.ts';
import { connectDatabase } from '../db/connection.ts';
import {
  organizationAccounts as accounts,
  instanceGrants as grants,
  instances,
  organizationEvents,
  organizations,
} from '../db/schema.ts';
import type { Env } from '../env';
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
  const binding = env.ORGANIZATION_HYPERDRIVE;
  const url = binding?.connectionString ?? env.ORGANIZATION_DATABASE_URL;
  if (!url) throw new OrganizationError('ORGANIZATION_UNAVAILABLE', 503);
  return connectDatabase(url, env.DATABASE_CA_CERT, !!binding);
}
type Database = Pick<
  ReturnType<typeof organizationDatabase>['db'],
  'select' | 'insert' | 'update' | 'delete' | 'transaction'
>;

async function audit(
  db: Database,
  actorId: string,
  action: typeof organizationEvents.$inferInsert.action,
  instanceId: string | null,
  details: Record<string, unknown> = {},
) {
  await db
    .insert(organizationEvents)
    .values({ id: crypto.randomUUID(), actorId, action, instanceId, details });
}

export async function organizationIdentity(
  db: Database,
  subject: string,
  known?: typeof organizations.$inferSelect,
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
    await db
      .insert(accounts)
      .values({ organizationId: organization.id, subject, actorId })
      .onConflictDoNothing();
    [account] = await db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.organizationId, organization.id), eq(accounts.subject, subject)),
      );
  }
  if (!account || account.actorId !== actorId)
    throw new OrganizationError('IDENTITY_CONFLICT', 409);
  return { organization, account };
}

export async function overview(
  db: Database,
  subject: string,
  initialSubject?: string,
  accountCursor?: string,
): Promise<OrganizationOverview> {
  if (
    accountCursor !== undefined &&
    (typeof accountCursor !== 'string' || !/^[0-9a-f]{64}$/.test(accountCursor))
  )
    throw new OrganizationError('INVALID_ACCOUNT', 400);
  const [existing] = await db.select().from(organizations);
  if (!existing)
    return {
      enabled: true,
      setup: { subject, eligible: !!initialSubject && subject === initialSubject },
      instances: [],
    };
  const { organization, account } = await organizationIdentity(db, subject, existing);
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
  const permissions = await db
    .select()
    .from(grants)
    .where(eq(grants.actorId, account.actorId));
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
    enabled: true,
    organization: { id: organization.id, name: organization.name },
    account: { actorId: account.actorId, administrator: account.administrator },
    instances: all
      .map((instance) => ({
        id: instance.id,
        name: instance.name,
        state: instance.state,
        permissions: permissions
          .filter((p) => p.instanceId === instance.id)
          .map((p) => p.permission),
      }))
      .filter((instance) =>
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

export async function setupOrganization(
  db: Database,
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  requireInstaller(subject, env.INITIAL_ADMIN_SUBJECT);
  const name = validName(input.name);
  const instanceName = validName(input.instanceName);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(716329410)`);
    const [existing] = await tx.select().from(organizations);
    if (existing) throw new OrganizationError('ALREADY_CONFIGURED', 409);
    const id = crypto.randomUUID();
    const identityNamespace = `urn:uuid:${id}`;
    const actorId = await actorForSubject(identityNamespace, subject);
    await tx.insert(organizations).values({ id, name, identityNamespace });
    await tx.insert(accounts).values({
      organizationId: id,
      subject,
      actorId,
      administrator: true,
    });
    // First-time setup is for a new installation. Existing deployments use the rehearsed migration procedure.
    const instanceId = crypto.randomUUID();
    await tx.insert(instances).values({
      id: instanceId,
      organizationId: id,
      owner: `urn:uuid:${instanceId}`,
      name: instanceName,
    });
    await audit(tx, actorId, 'setup', instanceId, {
      name,
      instanceName,
    });
  });
}

export async function addInstance(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const { organization, account } = await organizationIdentity(db, subject);
  requireAdministrator(account);
  const id = validId(input.id);
  const name = validName(input.name);
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(instances)
      .values({ id, organizationId: organization.id, owner: `urn:uuid:${id}`, name })
      .onConflictDoNothing()
      .returning({ id: instances.id });
    const [instance] = await tx.select().from(instances).where(eq(instances.id, id));
    if (
      !instance ||
      instance.organizationId !== organization.id ||
      instance.owner !== `urn:uuid:${id}`
    )
      throw new OrganizationError('INSTANCE_CONFLICT', 409);
    if (inserted.length) await audit(tx, account.actorId, 'add', id, { name });
  });
}

export async function publishInstance(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const { organization, account } = await organizationIdentity(db, subject);
  requireAdministrator(account);
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(instances)
      .set({ state: 'published' })
      .where(
        and(
          eq(instances.id, validId(input.id)),
          eq(instances.organizationId, organization.id),
        ),
      )
      .returning({ id: instances.id });
    if (!rows.length) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    await audit(tx, account.actorId, 'publish', validId(input.id), {});
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

export async function setInstanceGrants(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const { organization, account } = await organizationIdentity(db, subject);
  requireAdministrator(account);
  const id = validId(input.id);
  if (
    typeof input.actorId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.actorId) ||
    typeof input.expected !== 'string' ||
    input.expected.length > 64 ||
    !Array.isArray(input.permissions) ||
    input.permissions.length > instancePermissions.length ||
    input.permissions.some((p) => !instancePermissions.includes(p)) ||
    new Set(input.permissions).size !== input.permissions.length
  )
    throw new OrganizationError('INVALID_PERMISSION', 400);
  const actorId = input.actorId;
  const permissions = input.permissions as InstancePermission[];
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${id}`}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${id + actorId}, 0))`,
    );
    const [instance] = await tx
      .select()
      .from(instances)
      .where(and(eq(instances.id, id), eq(instances.organizationId, organization.id)));
    const [target] = await tx
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.actorId, actorId), eq(accounts.organizationId, organization.id)),
      );
    if (!instance || !target) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    const previous = await tx
      .select({ permission: grants.permission })
      .from(grants)
      .where(and(eq(grants.instanceId, id), eq(grants.actorId, actorId)));
    if (input.expected !== permissionRevision(previous.map((row) => row.permission)))
      throw new OrganizationError('EDIT_CONFLICT', 409);
    await tx
      .delete(grants)
      .where(and(eq(grants.instanceId, id), eq(grants.actorId, actorId)));
    if (permissions.length)
      await tx
        .insert(grants)
        .values(
          permissions.map((permission) => ({ instanceId: id, actorId, permission })),
        );
    await audit(tx, account.actorId, 'grants', id, {
      target: actorId,
      before: previous.map((row) => row.permission),
      after: permissions,
    });
  });
}

export async function renameInstance(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const { organization, account } = await organizationIdentity(db, subject);
  requireAdministrator(account);
  const expected = validName(input.expectedName);
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(instances)
      .set({ name: validName(input.name) })
      .where(
        and(
          eq(instances.id, validId(input.id)),
          eq(instances.name, expected),
          eq(instances.organizationId, organization.id),
        ),
      )
      .returning({ id: instances.id });
    if (!rows.length) throw new OrganizationError('EDIT_CONFLICT', 409);
    await audit(tx, account.actorId, 'rename', validId(input.id), {
      before: expected,
      after: validName(input.name),
    });
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
    enabled: true,
    instances: [],
    accounts: [{ actorId: target.actorId, administrator: target.administrator }],
    grants: permissions,
  };
}

// Called with server-owned room scope and participant IDs, never browser-supplied actor IDs.
export async function allowedInstanceActors(
  env: Env,
  scope: { id: string; owner: string },
  actors: string[],
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
          or(
            eq(instances.state, 'published'),
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
    return rows.map((row) => row.actorId);
  } finally {
    await close();
  }
}
