import { and, eq } from 'drizzle-orm';
import { changeD1, type Database } from '../db/d1.ts';
import { instanceDeletions, instances, matches } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError, requireAdministrator, validId } from './access.ts';
import { organizationIdentity } from './database.ts';

export async function requestInstanceDeletion(
  db: Database,
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  const id = validId(input.id),
    operationId = validId(input.operationId);
  if (!env.ACCOUNT_ERASURE) throw new OrganizationError('ERASURE_UNAVAILABLE', 503);
  await changeD1(db, async (writes) => {
    const tx = db;
    const { organization, account } = await organizationIdentity(tx, subject);
    requireAdministrator(account);
    const [previous] = await tx
      .select()
      .from(instanceDeletions)
      .where(eq(instanceDeletions.id, operationId));
    if (previous) {
      if (
        previous.instanceId !== id ||
        previous.organizationId !== organization.id ||
        previous.operatorId !== account.actorId ||
        previous.name !== input.name
      )
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return;
    }
    const [instance] = await tx
      .select()
      .from(instances)
      .where(and(eq(instances.id, id), eq(instances.organizationId, organization.id)));
    if (!instance) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    if (
      instance.name !== input.name ||
      instance.state !== 'archived' ||
      instance.operationRevision !== input.revision
    )
      throw new OrganizationError('EDIT_CONFLICT', 409);
    const [active] = await tx
      .select({ id: matches.matchId })
      .from(matches)
      .where(and(eq(matches.owner, instance.owner), eq(matches.status, 'running')))
      .limit(1);
    if (active) throw new OrganizationError('RESULT_OR_MATCH_PENDING', 409);
    writes.push(
      tx.insert(instanceDeletions).values({
        id: operationId,
        instanceId: id,
        organizationId: organization.id,
        owner: instance.owner,
        name: instance.name,
        operatorId: account.actorId,
      }),
    );
  });
  const response = await env.ACCOUNT_ERASURE.fetch(
    'https://account-erasure.internal/instance',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId }),
    },
  );
  if (response.status === 409)
    throw new OrganizationError('RESULT_OR_MATCH_PENDING', 409);
  if (!response.ok) throw new OrganizationError('DELETION_PENDING', 503);
  return { ok: true };
}
