import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { activeSanction } from '../../shared/moderation.ts';
import {
  type InstancePermission,
  instancePermissions,
  permissionRevision,
} from '../../shared/organization.ts';
import { contentHash } from '../catalog/hash.ts';
import {
  organizationAccounts as accounts,
  sanctionAppeals as appeals,
  moderationEvents as events,
  instanceGrants as grants,
  instances,
  organizationEvents,
  userReports as reports,
  moderationRequests as requests,
  moderationSanctions as sanctions,
  administratorTransfers as transfers,
} from '../db/schema.ts';
import type { ResultRecord } from '../results/record.ts';
import { OrganizationError, validId } from './access.ts';
import { organizationIdentity } from './database.ts';
import { canAct, context, type Database, targetUser } from './moderation.ts';

const fail = (code: string, status: 400 | 403 | 404 | 409 = 400): never => {
  throw new OrganizationError(code, status);
};
const reasonOf = (value: unknown) =>
  typeof value === 'string' && value.trim() && value.length <= 1000
    ? value.trim()
    : fail('REASON_REQUIRED');
export async function moderationWorkflow(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
  evidence?: ResultRecord,
) {
  const operationId = validId(input.operationId),
    hash = await contentHash(input);
  return db.transaction(async (tx) => {
    const initial = await organizationIdentity(tx, subject);
    const scopes = await tx
      .select()
      .from(instances)
      .where(eq(instances.organizationId, initial.organization.id))
      .orderBy(asc(instances.id));
    // All account/permission mutations share this lock order with sanctions and profile edits.
    for (const scope of scopes)
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`questions:${scope.id}`},0))`,
      );
    const { organization, account } = await organizationIdentity(tx, subject);
    const [previous] = await tx
      .select()
      .from(requests)
      .where(eq(requests.id, operationId));
    if (previous) {
      if (previous.operatorId !== account.actorId || previous.requestHash !== hash)
        fail('OPERATION_CONFLICT', 409);
      return { ok: true };
    }
    const action = input.action,
      now = new Date().toISOString();
    if (action === 'report') {
      const instanceId = validId(input.instanceId),
        scope = scopes.find((r) => r.id === instanceId);
      const actorId = String(input.actorId);
      if (
        !scope ||
        !evidence ||
        evidence.owner !== scope.owner ||
        evidence.result.id !== input.resultId ||
        !evidence.players.some((p) => p.id === account.actorId) ||
        !evidence.players.some((p) => p.id === actorId && !p.guest) ||
        actorId === account.actorId
      )
        fail('REPORT_NOT_ALLOWED', 403);
      await targetUser(tx, organization.id, actorId);
      await tx.insert(reports).values({
        id: operationId,
        organizationId: organization.id,
        instanceId,
        actorId,
        reporterId: account.actorId,
        resultId: validId(input.resultId),
        reason: reasonOf(input.reason),
      });
    } else if (action === 'resolveReports') {
      const instanceId = validId(input.instanceId);
      await context(tx, subject, instanceId);
      if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100)
        fail('INVALID_REPORT');
      const ids = (input.ids as unknown[]).map(validId);
      const rows = await tx
        .select()
        .from(reports)
        .where(
          and(
            inArray(reports.id, ids),
            eq(reports.organizationId, organization.id),
            eq(reports.instanceId, instanceId),
            eq(reports.actorId, String(input.actorId)),
            isNull(reports.resolvedAt),
          ),
        );
      if (rows.length !== new Set(ids).size) fail('EDIT_CONFLICT', 409);
      await tx
        .update(reports)
        .set({
          resolvedAt: now,
          operatorId: account.actorId,
          resolution: reasonOf(input.reason),
        })
        .where(inArray(reports.id, ids));
    } else if (action === 'appeal') {
      const [sanction] = await tx
        .select()
        .from(sanctions)
        .where(
          and(
            eq(sanctions.id, validId(input.id)),
            eq(sanctions.actorId, account.actorId),
            eq(sanctions.organizationId, organization.id),
          ),
        );
      if (!sanction || !activeSanction(sanction) || sanction.kind !== 'ban')
        fail('SANCTION_NOT_FOUND', 404);
      const [open] = await tx
        .select()
        .from(appeals)
        .where(and(eq(appeals.sanctionId, sanction.id), isNull(appeals.resolvedAt)));
      if (open) fail('APPEAL_PENDING', 409);
      await tx.insert(appeals).values({
        id: operationId,
        organizationId: organization.id,
        actorId: account.actorId,
        sanctionId: sanction.id,
        sanctionRevision: sanction.revision,
        reason: reasonOf(input.reason),
      });
    } else if (action === 'decideAppeal') {
      const instanceId = validId(input.instanceId);
      const ctx = await context(tx, subject, instanceId);
      const [appeal] = await tx
        .select()
        .from(appeals)
        .where(
          and(
            eq(appeals.id, validId(input.id)),
            eq(appeals.organizationId, organization.id),
          ),
        );
      if (!appeal || appeal.resolvedAt) fail('EDIT_CONFLICT', 409);
      const [sanction] = await tx
        .select()
        .from(sanctions)
        .where(eq(sanctions.id, appeal.sanctionId));
      if (
        !sanction ||
        (sanction.instanceId !== null && sanction.instanceId !== instanceId)
      )
        fail('MODERATION_REQUIRED', 403);
      if (
        !(await canAct(
          tx,
          ctx.account,
          await targetUser(tx, organization.id, appeal.actorId),
        ))
      )
        fail('PROTECTED_ACCOUNT', 403);
      const reason = reasonOf(input.reason),
        decision = input.decision;
      if (decision !== 'maintain' && decision !== 'revoke') fail('INVALID_DECISION');
      if (!activeSanction(sanction) || sanction.revision !== input.sanctionRevision)
        fail('EDIT_CONFLICT', 409);
      if (decision === 'revoke') {
        const after = {
          ...sanction,
          revokedAt: now,
          revision: sanction.revision + 1,
          reason,
        };
        await tx.update(sanctions).set(after).where(eq(sanctions.id, sanction.id));
        await tx.insert(events).values({
          id: operationId,
          organizationId: organization.id,
          instanceId: sanction.instanceId,
          actorId: appeal.actorId,
          operatorId: account.actorId,
          action: 'revoke',
          reason,
          requestHash: hash,
          before: sanction,
          after,
        });
      }
      await tx
        .update(appeals)
        .set({
          readAt: null,
          resolvedAt: now,
          resolution: reason,
          decision: decision as 'maintain' | 'revoke',
          operatorId: account.actorId,
        })
        .where(eq(appeals.id, appeal.id));
    } else if (action === 'permissions') {
      if (!account.administrator) fail('ADMIN_REQUIRED', 403);
      const id = validId(input.instanceId),
        actorId = String(input.actorId);
      if (!scopes.some((s) => s.id === id)) fail('INSTANCE_NOT_FOUND', 404);
      await targetUser(tx, organization.id, actorId);
      if (
        !Array.isArray(input.permissions) ||
        input.permissions.length > instancePermissions.length ||
        input.permissions.some((p) => !instancePermissions.includes(p)) ||
        new Set(input.permissions).size !== input.permissions.length
      )
        fail('INVALID_PERMISSION');
      const previous = await tx
        .select()
        .from(grants)
        .where(and(eq(grants.instanceId, id), eq(grants.actorId, actorId)));
      if (input.expected !== permissionRevision(previous.map((p) => p.permission)))
        fail('EDIT_CONFLICT', 409);
      await tx
        .delete(grants)
        .where(and(eq(grants.instanceId, id), eq(grants.actorId, actorId)));
      const permissions = input.permissions as InstancePermission[];
      if (permissions.length)
        await tx
          .insert(grants)
          .values(
            permissions.map((permission) => ({ instanceId: id, actorId, permission })),
          );
      await tx.insert(organizationEvents).values({
        id: operationId,
        actorId: account.actorId,
        instanceId: id,
        action: 'grants',
        details: {
          target: actorId,
          before: previous.map((p) => p.permission),
          after: permissions,
        },
      });
    } else if (action === 'inviteAdmin') {
      if (!account.administrator) fail('ADMIN_REQUIRED', 403);
      const target = await targetUser(tx, organization.id, String(input.actorId));
      if (
        target.actorId === account.actorId ||
        target.administrator ||
        typeof input.keepSender !== 'boolean'
      )
        fail('INVALID_ACCOUNT');
      const [open] = await tx
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.organizationId, organization.id),
            eq(transfers.state, 'pending'),
            eq(transfers.targetId, target.actorId),
            sql`${transfers.expiresAt}>now()`,
          ),
        );
      if (open) fail('TRANSFER_PENDING', 409);
      await tx.insert(transfers).values({
        id: operationId,
        organizationId: organization.id,
        senderId: account.actorId,
        targetId: target.actorId,
        keepSender: input.keepSender as boolean,
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      });
    } else if (action === 'acceptAdmin' || action === 'cancelAdmin') {
      const [invite] = await tx
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.id, validId(input.id)),
            eq(transfers.organizationId, organization.id),
          ),
        );
      if (invite?.state !== 'pending') fail('EDIT_CONFLICT', 409);
      if (action === 'acceptAdmin') {
        if (
          invite.targetId !== account.actorId ||
          Date.parse(invite.expiresAt) <= Date.now()
        )
          fail('INVITATION_INVALID', 403);
        const sender = await targetUser(tx, organization.id, invite.senderId);
        if (!sender.administrator) fail('INVITATION_INVALID', 409);
        await tx
          .update(accounts)
          .set({ administrator: true })
          .where(eq(accounts.actorId, account.actorId));
        if (!invite.keepSender)
          await tx
            .update(accounts)
            .set({ administrator: false })
            .where(eq(accounts.actorId, sender.actorId));
      } else if (invite.senderId !== account.actorId && !account.administrator)
        fail('ADMIN_REQUIRED', 403);
      await tx
        .update(transfers)
        .set({ state: action === 'acceptAdmin' ? 'accepted' : 'cancelled' })
        .where(eq(transfers.id, invite.id));
    } else fail('INVALID_ACTION');
    await tx.insert(requests).values({
      id: operationId,
      organizationId: organization.id,
      operatorId: account.actorId,
      requestHash: hash,
      details: input,
    });
    return { ok: true };
  });
}
