import { and, eq, inArray, isNull } from 'drizzle-orm';
import { blocks } from '../../shared/moderation.ts';
import type { Database } from '../db/d1.ts';
import {
  federationActors,
  instances,
  moderationSanctions,
  organizationAccounts,
  organizations,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import {
  allowedInstanceActors,
  organizationIdentity,
  resolveInstance,
} from '../organization/database.ts';

// Keep old instance-scoped reservations intact. New participation uses the permanent organization ID.
export async function participationSource(db: Database, subject: string, id: string) {
  const identity = await organizationIdentity(db, subject);
  if (id === identity.organization.id) return { ...identity, instance: null };
  return resolveInstance(db, subject, id);
}

export async function sourceActors(
  env: Env,
  db: Database,
  sourceId: string,
  mode: 'ranked' | 'casual' | 'room',
  actors: string[],
  existing = false,
) {
  if (!actors.length) return [];
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, sourceId));
  const [instance] = organization
    ? []
    : await db.select().from(instances).where(eq(instances.id, sourceId));
  const organizationId = organization?.id ?? instance?.organizationId;
  if (!organizationId || (!existing && instance?.state === 'archived')) return [];
  const accounts = await db
    .select()
    .from(organizationAccounts)
    .where(
      and(
        eq(organizationAccounts.organizationId, organizationId),
        inArray(organizationAccounts.actorId, actors),
        isNull(organizationAccounts.withdrawnAt),
      ),
    );
  const foreign = await db
    .select({ id: federationActors.actorId })
    .from(federationActors)
    .where(inArray(federationActors.actorId, actors));
  const local = accounts
    .map((row) => row.actorId)
    .filter((id) => !foreign.some((row) => row.id === id));
  if (existing) return local;
  if (instance)
    return allowedInstanceActors(
      env,
      {
        id: instance.id,
        owner: instance.owner,
        ...(mode === 'ranked' ? {} : { mode }),
      },
      local,
    );
  const sanctions = await db
    .select()
    .from(moderationSanctions)
    .where(
      and(
        eq(moderationSanctions.organizationId, organizationId),
        inArray(moderationSanctions.actorId, actors),
        isNull(moderationSanctions.instanceId),
      ),
    );
  return local.filter(
    (id) =>
      !sanctions.some(
        (row) =>
          row.actorId === id && blocks(row, mode === 'ranked' ? 'ranked' : 'casual'),
      ),
  );
}
