import { and, eq, sql } from 'drizzle-orm';
import { contentHash } from '../catalog/hash.ts';
import { instanceDeletions, instances, moderationRequests } from '../db/schema.ts';
import { OrganizationError, requireAdministrator, validId } from './access.ts';
import { type organizationDatabase, organizationIdentity } from './database.ts';

export async function changeInstanceOperation(
  db: Pick<ReturnType<typeof organizationDatabase>['db'], 'transaction'>,
  subject: string,
  input: Record<string, unknown>,
) {
  const id = validId(input.id),
    operationId = validId(input.operationId);
  const hash = await contentHash(input);
  const action = input.action;
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
    ].includes(String(action)) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 0
  )
    throw new OrganizationError('INVALID_OPERATION', 400);
  const stopping = ['prepare', 'stopRanked', 'stopCasual'].includes(String(action));
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (stopping && (!reason || reason.length > 1000))
    throw new OrganizationError('REASON_REQUIRED', 400);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${id}`}, 0))`,
    );
    const { organization, account } = await organizationIdentity(tx, subject);
    requireAdministrator(account);
    const [previous] = await tx
      .select()
      .from(moderationRequests)
      .where(eq(moderationRequests.id, operationId));
    if (previous) {
      if (previous.operatorId !== account.actorId || previous.requestHash !== hash)
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return { organizationId: organization.id };
    }
    const [instance] = await tx
      .select()
      .from(instances)
      .where(and(eq(instances.id, id), eq(instances.organizationId, organization.id)));
    if (!instance) throw new OrganizationError('INSTANCE_NOT_FOUND', 404);
    if (
      (
        await tx
          .select()
          .from(instanceDeletions)
          .where(eq(instanceDeletions.instanceId, id))
      ).length
    )
      throw new OrganizationError('INSTANCE_DELETING', 409);
    if ((instance.state === 'archived') !== (action === 'restore'))
      if (instance.state === 'archived' || action === 'restore')
        throw new OrganizationError('EDIT_CONFLICT', 409);
    if (instance.operationRevision !== input.revision)
      throw new OrganizationError('EDIT_CONFLICT', 409);
    await tx
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
      .where(eq(instances.id, id));
    await tx.insert(moderationRequests).values({
      id: operationId,
      organizationId: organization.id,
      operatorId: account.actorId,
      requestHash: hash,
      details: input,
    });
    return { organizationId: organization.id };
  });
}
