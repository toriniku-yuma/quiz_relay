import { and, eq, inArray, isNull } from 'drizzle-orm';
import { blocks } from '../../shared/moderation.ts';
import type { Database } from '../db/d1.ts';
import {
  federationActors,
  moderationSanctions,
  organizationAccounts,
  organizations,
} from '../db/schema.ts';
import { OrganizationError } from '../organization/access.ts';
import { organizationIdentity } from '../organization/database.ts';

// Participation always comes from the actor's whole organization.
export async function participationSource(
  db: Database,
  subject: string,
  sourceOrganizationId: string,
) {
  const identity = await organizationIdentity(db, subject);
  if (sourceOrganizationId !== identity.organization.id)
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  return identity;
}

export async function sourceActors(
  db: Database,
  sourceOrganizationId: string,
  mode: 'ranked' | 'casual' | 'room',
  actors: string[],
  existing = false,
) {
  if (!actors.length) return [];
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, sourceOrganizationId));
  if (!organization) return [];
  const organizationId = organization.id;
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
