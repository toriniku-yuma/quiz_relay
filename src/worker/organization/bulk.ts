import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { activeSanction, sanctionRevision } from '../../shared/moderation.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, type Database, rowsD1 } from '../db/d1.ts';
import {
  instanceGrants,
  moderationEvents,
  moderationRequests,
  moderationSanctions,
  organizationAccounts,
  sanctionAppeals,
} from '../db/schema.ts';
import { OrganizationError, validId } from './access.ts';
import { context, sanctionChange } from './moderation.ts';

export async function bulkSanctions(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const operationId = validId(input.operationId);
  const instanceId = input.instanceId === null ? null : validId(input.instanceId);
  if (
    ((input.organizationWide === true || instanceId === null) && input.kind !== 'ban') ||
    !['add', 'revoke'].includes(String(input.batchAction)) ||
    !['ban', 'timeout', 'partial'].includes(String(input.kind)) ||
    !Array.isArray(input.targets) ||
    !input.targets.length ||
    input.targets.length > 500
  )
    throw new OrganizationError('INVALID_SANCTION', 400);
  const targets = input.targets as { actorId: string; expected: string }[];
  if (
    targets.some(
      (target) =>
        !target ||
        typeof target.actorId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(target.actorId) ||
        typeof target.expected !== 'string',
    )
  )
    throw new OrganizationError('INVALID_ACCOUNT', 400);
  if (new Set(targets.map((target) => target.actorId)).size !== targets.length)
    throw new OrganizationError('INVALID_SANCTION', 400);
  const hash = await contentHash(input);
  const selected = JSON.stringify(targets.map((target) => target.actorId));
  return changeD1(db, async (writes) => {
    const ctx = await context(db, subject, instanceId);
    const sanctionScope = input.organizationWide === true ? null : instanceId;
    if (sanctionScope === null && !ctx.account.administrator)
      throw new OrganizationError('ADMIN_REQUIRED', 403);
    const [receipt] = await db
      .select()
      .from(moderationRequests)
      .where(eq(moderationRequests.id, operationId));
    const results = targets.map((target) => ({
      actorId: target.actorId,
      instanceIds: sanctionScope
        ? [sanctionScope]
        : ctx.scopes.map((instance) => instance.id),
    }));
    if (receipt) {
      if (receipt.operatorId !== ctx.account.actorId || receipt.requestHash !== hash)
        throw new OrganizationError('OPERATION_CONFLICT', 409);
      return results;
    }
    const accounts = await db
      .select()
      .from(organizationAccounts)
      .where(
        and(
          eq(organizationAccounts.organizationId, ctx.organization.id),
          sql`${organizationAccounts.actorId} in (select value from json_each(${selected}))`,
        ),
      );
    const protectedActors = await db
      .selectDistinct({ actorId: instanceGrants.actorId })
      .from(instanceGrants)
      .where(
        sql`${instanceGrants.actorId} in (select value from json_each(${selected}))`,
      );
    const current = await db
      .select()
      .from(moderationSanctions)
      .where(
        and(
          eq(moderationSanctions.organizationId, ctx.organization.id),
          sql`${moderationSanctions.actorId} in (select value from json_each(${selected}))`,
          instanceId
            ? or(
                eq(moderationSanctions.instanceId, instanceId),
                isNull(moderationSanctions.instanceId),
              )
            : isNull(moderationSanctions.instanceId),
        ),
      );
    const changes: (typeof moderationSanctions.$inferInsert)[] = [];
    const events: (typeof moderationEvents.$inferInsert)[] = [];
    const revoked: string[] = [];
    for (const item of targets) {
      const target = accounts.find((account) => account.actorId === item.actorId);
      try {
        if (!target) throw new OrganizationError('ACCOUNT_NOT_FOUND', 404);
        if (target.withdrawnAt) throw new OrganizationError('ACCOUNT_WITHDRAWN', 409);
        if (
          target.actorId === ctx.account.actorId ||
          (!ctx.account.administrator &&
            (target.administrator ||
              protectedActors.some((grant) => grant.actorId === target.actorId)))
        )
          throw new OrganizationError('PROTECTED_ACCOUNT', 403);
        const sanctions = current.filter(
          (sanction) => sanction.actorId === target.actorId,
        );
        if (sanctionRevision(sanctions) !== item.expected)
          throw new OrganizationError('EDIT_CONFLICT', 409);
        const previous =
          input.batchAction === 'add'
            ? [null]
            : sanctions.filter(
                (sanction) =>
                  activeSanction(sanction) &&
                  sanction.kind === input.kind &&
                  sanction.instanceId === sanctionScope,
              );
        for (const before of previous) {
          const id = crypto.randomUUID();
          const action = input.batchAction === 'add' ? 'add' : 'revoke';
          const request = {
            ...input,
            actorId: item.actorId,
            action,
            operationId: id,
            ...(before ? { id: before.id, revision: before.revision } : {}),
          };
          const after = sanctionChange(request, sanctionScope, item.actorId, id, before);
          changes.push({ ...after, organizationId: ctx.organization.id });
          events.push({
            id,
            organizationId: ctx.organization.id,
            instanceId: sanctionScope,
            actorId: item.actorId,
            operatorId: ctx.account.actorId,
            action,
            reason: after.reason,
            requestHash: await contentHash(request),
            before,
            after,
          });
          if (before?.kind === 'ban') revoked.push(before.id);
        }
      } catch (error) {
        if (error instanceof OrganizationError)
          error.target = target?.displayName || '表示名未登録';
        throw error;
      }
    }
    if (changes.length)
      writes.push(
        rowsD1(moderationSanctions, changes, true),
        rowsD1(moderationEvents, events),
      );
    if (revoked.length)
      writes.push(
        db
          .update(sanctionAppeals)
          .set({
            resolvedAt: new Date().toISOString(),
            operatorId: ctx.account.actorId,
            resolution: String(input.reason).trim(),
            decision: 'revoke',
            readAt: null,
          })
          .where(
            and(
              sql`${sanctionAppeals.sanctionId} in (select value from json_each(${JSON.stringify(revoked)}))`,
              isNull(sanctionAppeals.resolvedAt),
            ),
          ),
      );
    writes.push(
      db.insert(moderationRequests).values({
        id: operationId,
        organizationId: ctx.organization.id,
        operatorId: ctx.account.actorId,
        requestHash: hash,
        details: {
          instanceId,
          action: 'bulk-sanctions',
          targets: targets.map((target) => target.actorId),
        },
      }),
    );
    return results;
  });
}
