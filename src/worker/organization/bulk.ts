import { eq, sql } from 'drizzle-orm';
import { activeSanction, sanctionRevision } from '../../shared/moderation.ts';
import { contentHash } from '../catalog/hash.ts';
import { moderationRequests } from '../db/schema.ts';
import { OrganizationError, validId } from './access.ts';
import {
  actorSanctions,
  canAct,
  context,
  type Database,
  mutateSanction,
  targetUser,
} from './moderation.ts';
export async function bulkSanctions(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const operationId = validId(input.operationId),
    instanceId = validId(input.instanceId),
    hash = await contentHash(input);
  if (
    (input.organizationWide === true && input.kind !== 'ban') ||
    !['add', 'revoke'].includes(String(input.batchAction)) ||
    !['ban', 'timeout', 'partial'].includes(String(input.kind)) ||
    !Array.isArray(input.targets) ||
    !input.targets.length ||
    input.targets.length > 500
  )
    throw new OrganizationError('INVALID_SANCTION', 400);
  const targets = input.targets as { actorId: string; expected: string }[];
  if (new Set(targets.map((t) => t.actorId)).size !== targets.length)
    throw new OrganizationError('INVALID_SANCTION', 400);
  return db.transaction(async (tx) => {
    const initial = await context(tx, subject, instanceId);
    for (const scope of initial.scopes)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${scope.id}`},0))`,
      );
    const ctx = await context(tx, subject, instanceId);
    const [receipt] = await tx
      .select()
      .from(moderationRequests)
      .where(eq(moderationRequests.id, operationId));
    const results = targets.map((t) => ({
      actorId: t.actorId,
      instanceIds:
        input.organizationWide === true ? ctx.scopes.map((s) => s.id) : [instanceId],
    }));
    if (receipt) {
      if (receipt.operatorId !== ctx.account.actorId || receipt.requestHash !== hash)
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return results;
    }
    for (const item of targets) {
      if (typeof item.actorId !== 'string' || !/^[a-f0-9]{64}$/.test(item.actorId))
        throw new OrganizationError('INVALID_ACCOUNT', 400);
      const target = await targetUser(tx, ctx.organization.id, item.actorId);
      try {
        if (!(await canAct(tx, ctx.account, target)))
          throw new OrganizationError('PROTECTED_ACCOUNT', 403);
        const current = await actorSanctions(
          tx,
          ctx.organization.id,
          item.actorId,
          instanceId,
        );
        if (sanctionRevision(current) !== item.expected)
          throw new OrganizationError('EDIT_CONFLICT', 409);
        if (input.batchAction === 'add')
          await mutateSanction(tx, subject, {
            ...input,
            actorId: item.actorId,
            action: 'add',
            operationId: crypto.randomUUID(),
          });
        else
          for (const row of current.filter(
            (r) =>
              activeSanction(r) &&
              r.kind === input.kind &&
              r.instanceId === (input.organizationWide === true ? null : instanceId),
          ))
            await mutateSanction(tx, subject, {
              ...input,
              actorId: item.actorId,
              action: 'revoke',
              id: row.id,
              revision: row.revision,
              operationId: crypto.randomUUID(),
            });
      } catch (error) {
        if (error instanceof OrganizationError)
          error.target = target.displayName || '表示名未登録';
        throw error;
      }
    }
    await tx.insert(moderationRequests).values({
      id: operationId,
      organizationId: ctx.organization.id,
      operatorId: ctx.account.actorId,
      requestHash: hash,
      details: {
        instanceId,
        action: 'bulk-sanctions',
        targets: targets.map((t) => t.actorId),
      },
    });
    return results;
  });
}
