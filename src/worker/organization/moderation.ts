import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import {
  activeSanction,
  blocks,
  type ModerationOverview,
  parseSanction,
  type Restriction,
  type Sanction,
} from '../../shared/moderation.ts';
import { paginationInput } from '../../shared/pagination.ts';
import { eventSortKeys, sortInput, userSortKeys } from '../../shared/sorting.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1, type Database, readD1 } from '../db/d1.ts';
import {
  organizationAccounts as accounts,
  administratorTransfers,
  moderationEvents as events,
  instanceGrants as grants,
  instances,
  sanctionAppeals,
  moderationSanctions as sanctions,
  userReports,
} from '../db/schema.ts';
import { orderValue } from '../db/sorting.ts';
import { OrganizationError, validId } from './access.ts';
import { organizationIdentity } from './database.ts';
import { accountDisplayName, accountHomeOrigin } from './display-name.ts';

export type { Database } from '../db/d1.ts';

const fail = (code: string, status: 400 | 403 | 404 | 409 = 403): never => {
  throw new OrganizationError(code, status);
};
const actor = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    ? value
    : fail('INVALID_ACCOUNT', 400);
const scopeFilter = (id: string | null) =>
  id ? eq(sanctions.instanceId, id) : isNull(sanctions.instanceId);

export async function context(db: Database, subject: string, instanceId: string | null) {
  const identity = await organizationIdentity(db, subject);
  const scopes = await db
    .select()
    .from(instances)
    .where(eq(instances.organizationId, identity.organization.id))
    .orderBy(asc(instances.id));
  const instance = scopes.find((row) => row.id === instanceId);
  if (instanceId && !instance) fail('INSTANCE_NOT_FOUND', 404);
  if (!identity.account.administrator) {
    if (!instanceId) fail('ADMIN_REQUIRED');
    const [permission] = await db
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.instanceId, instanceId as string),
          eq(grants.actorId, identity.account.actorId),
          eq(grants.permission, 'users'),
        ),
      );
    if (!permission) fail('MODERATION_REQUIRED');
  }
  return { ...identity, scopes, instance };
}
export async function actorSanctions(
  db: Pick<Database, 'select'>,
  organizationId: string,
  actorId: string,
  instanceId?: string,
) {
  return db
    .select()
    .from(sanctions)
    .where(
      and(
        eq(sanctions.organizationId, organizationId),
        eq(sanctions.actorId, actorId),
        instanceId
          ? or(eq(sanctions.instanceId, instanceId), isNull(sanctions.instanceId))
          : undefined,
      ),
    );
}
export async function requireUnrestricted(
  db: Pick<Database, 'select'>,
  organizationId: string,
  actorId: string,
  instanceId: string,
  action: Restriction,
) {
  if (
    (await actorSanctions(db, organizationId, actorId, instanceId)).some((row) =>
      blocks(row, action),
    )
  )
    fail('PARTICIPATION_RESTRICTED', 409);
}
export async function targetUser(
  db: Database,
  organizationId: string,
  actorId: string,
  allowWithdrawn = false,
) {
  const [target] = await db
    .select({
      ...getTableColumns(accounts),
      displayName: accountDisplayName,
      origin: accountHomeOrigin(''),
    })
    .from(accounts)
    .where(
      and(eq(accounts.organizationId, organizationId), eq(accounts.actorId, actorId)),
    );
  if (!target) fail('ACCOUNT_NOT_FOUND', 404);
  if (target.withdrawnAt && !allowWithdrawn) fail('ACCOUNT_WITHDRAWN', 409);
  return target;
}
export async function canAct(
  db: Database,
  operator: typeof accounts.$inferSelect,
  target: typeof accounts.$inferSelect,
) {
  if (operator.actorId === target.actorId) return false;
  if (target.withdrawnAt) return false;
  if (operator.administrator) return true;
  if (target.administrator) return false;
  return !(
    await db
      .select({ id: grants.actorId })
      .from(grants)
      .where(eq(grants.actorId, target.actorId))
      .limit(1)
  ).length;
}
export async function moderationOverview(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
): Promise<ModerationOverview> {
  const instanceId = input.instanceId === null ? null : validId(input.instanceId);
  if (input.actorId) {
    const targetId = actor(input.actorId);
    const createdAt = new Date().toISOString();
    const eventsBefore = input.eventsBefore ?? createdAt;
    if (typeof eventsBefore !== 'string' || !Number.isFinite(Date.parse(eventsBefore)))
      fail('INVALID_SEARCH', 400);
    try {
      paginationInput({ page: input.eventPage, pageSize: input.eventPageSize });
      sortInput(
        { sort: input.eventSort, direction: input.eventDirection },
        eventSortKeys,
        'createdAt',
      );
    } catch {
      fail('INVALID_SEARCH', 400);
    }
    const id = crypto.randomUUID();
    await changeD1(db, async (writes) => {
      const ctx = await context(db, subject, instanceId);
      await targetUser(db, ctx.organization.id, targetId, true);
      writes.push(
        db.insert(events).values({
          id,
          createdAt,
          organizationId: ctx.organization.id,
          instanceId,
          actorId: targetId,
          operatorId: ctx.account.actorId,
          action: 'inspect',
          reason: 'ユーザー詳細・戦績の調査閲覧',
          requestHash: '',
        }),
      );
    });
    input = { ...input, eventsBefore };
  }
  return readD1(db, async () => {
    const tx = db;
    const ctx = await context(tx, subject, instanceId);
    const origin = ctx.organization.name;
    const view = (
      row: Pick<
        typeof accounts.$inferSelect,
        'actorId' | 'displayName' | 'administrator' | 'withdrawnAt'
      > & { origin?: string },
    ) => ({
      actorId: row.actorId,
      name: row.withdrawnAt ? '退会ユーザー' : (row.displayName ?? '表示名未登録'),
      origin: row.origin || origin,
      administrator: row.administrator,
    });
    const base = {
      scopeName: ctx.instance?.name ?? origin,
      users: [],
      next: null,
      sanctions: [],
      events: [],
      canModerate: false,
      administrator: ctx.account.administrator,
    };
    if (input.actorId) {
      const target = await targetUser(
        tx,
        ctx.organization.id,
        actor(input.actorId),
        true,
      );
      const rows = await actorSanctions(
        tx,
        ctx.organization.id,
        target.actorId,
        instanceId ?? undefined,
      );
      const eventsBefore = input.eventsBefore ?? new Date().toISOString();
      if (typeof eventsBefore !== 'string' || !Number.isFinite(Date.parse(eventsBefore)))
        return fail('INVALID_SEARCH', 400);
      let eventPaging: ReturnType<typeof paginationInput>;
      let eventSorting: ReturnType<typeof sortInput>;
      try {
        eventPaging = paginationInput({
          page: input.eventPage,
          pageSize: input.eventPageSize,
        });
        eventSorting = sortInput(
          { sort: input.eventSort, direction: input.eventDirection },
          eventSortKeys,
          'createdAt',
        );
      } catch {
        return fail('INVALID_SEARCH', 400);
      }
      const eventFilter = and(
        lte(events.createdAt, eventsBefore),
        eq(events.organizationId, ctx.organization.id),
        eq(events.actorId, target.actorId),
        instanceId
          ? or(eq(events.instanceId, instanceId), isNull(events.instanceId))
          : undefined,
      );
      const [{ total: eventTotal }] = await tx
        .select({ total: sql<number>`count(*)` })
        .from(events)
        .where(eventFilter);
      const eventPage = Math.min(
        eventPaging.page,
        Math.max(1, Math.ceil(eventTotal / eventPaging.pageSize)),
      );
      const eventValues = {
        createdAt: events.createdAt,
        action: sql`case ${events.action} when 'add' then '追加' when 'change' then '変更' when 'revoke' then '取消' else '調査閲覧' end`,
        operator: sql`(select display_name from quiz_game_organization_accounts where actor_id = ${events.operatorId})`,
        scope: sql`case when ${events.instanceId} is null then '組織全体' else (select name from quiz_game_instances where id = ${events.instanceId}) end`,
        reason: sql`nullif(${events.reason}, '')`,
      };
      return {
        ...base,
        eventsBefore,
        eventsPagination: {
          page: eventPage,
          pageSize: eventPaging.pageSize,
          total: eventTotal,
        },
        target: {
          ...view(target),
          permissions: [
            ...new Set(
              (
                await tx
                  .select()
                  .from(grants)
                  .where(
                    and(
                      eq(grants.actorId, target.actorId),
                      instanceId ? eq(grants.instanceId, instanceId) : undefined,
                    ),
                  )
              ).map((grant) => grant.permission),
            ),
          ],
        },
        canModerate: await canAct(tx, ctx.account, target),

        sanctions: rows,
        operatorNames: Object.fromEntries(
          (
            await tx
              .select({ actorId: accounts.actorId, name: accountDisplayName })
              .from(accounts)
              .where(eq(accounts.organizationId, ctx.organization.id))
          ).map((account) => [account.actorId, account.name ?? '表示名未登録']),
        ),
        reports: (
          await tx
            .select()
            .from(userReports)
            .where(
              and(
                eq(userReports.actorId, target.actorId),
                eq(userReports.organizationId, ctx.organization.id),
                instanceId ? eq(userReports.instanceId, instanceId) : undefined,
              ),
            )
            .orderBy(desc(userReports.createdAt))
        ).map((report) => ({ ...report, reporterName: '通報者' })),
        appeals: rows.length
          ? (
              await tx
                .select()
                .from(sanctionAppeals)
                .where(
                  and(
                    eq(sanctionAppeals.actorId, target.actorId),
                    sql`${sanctionAppeals.sanctionId} in (select value from json_each(${JSON.stringify(rows.map((sanction) => sanction.id))}))`,
                  ),
                )
            ).flatMap((appeal) => {
              const sanction = rows.find(
                (candidateSanction) => candidateSanction.id === appeal.sanctionId,
              );
              return sanction ? [{ ...appeal, sanction }] : [];
            })
          : [],

        events: await tx
          .select()
          .from(events)
          .where(eventFilter)
          .orderBy(
            orderValue(
              eventValues[eventSorting.sort as keyof typeof eventValues],
              eventSorting.direction,
            ),
            desc(events.id),
          )
          .limit(eventPaging.pageSize)
          .offset((eventPage - 1) * eventPaging.pageSize),
      };
    }
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (query.length > 100) fail('INVALID_SEARCH', 400);

    let paging: ReturnType<typeof paginationInput>;
    try {
      paging = paginationInput(input);
    } catch {
      return fail('INVALID_PAGE', 400);
    }
    const reportScope = instanceId ? sql`and instance_id = ${instanceId}` : sql``;
    const sanctionScope = instanceId
      ? sql`and (instance_id = ${instanceId} or instance_id is null)`
      : sql``;
    const appealScope = instanceId
      ? sql`and (s.instance_id = ${instanceId} or s.instance_id is null)`
      : sql``;
    const reportCount = sql<number>`(select count(distinct reporter_id) from quiz_game_user_reports where actor_id = "quiz_game_organization_accounts"."actor_id" ${reportScope} and resolved_at is null)`;
    const appealCount = sql<number>`(select count(*) from quiz_game_sanction_appeals a join quiz_game_moderation_sanctions s on s.id=a.sanction_id where a.actor_id = "quiz_game_organization_accounts"."actor_id" and a.resolved_at is null ${appealScope})`;
    const restricted = sql`exists(select 1 from quiz_game_moderation_sanctions where actor_id="quiz_game_organization_accounts"."actor_id" ${sanctionScope} and revoked_at is null and (expires_at is null or expires_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`;
    if (!['', 'restricted', 'reports', 'appeals'].includes(String(input.filter ?? '')))
      return fail('INVALID_SEARCH', 400);
    let sorting: ReturnType<typeof sortInput>;
    try {
      sorting = sortInput(
        input,
        userSortKeys,
        'reports',
        input.sort === 'name' || input.sort === 'origin' ? 'asc' : 'desc',
      );
    } catch {
      return fail('INVALID_SEARCH', 400);
    }
    const activeScope = sql`actor_id = "quiz_game_organization_accounts"."actor_id" ${sanctionScope} and revoked_at is null and (expires_at is null or expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
    const userValues = {
      name: accountDisplayName,
      origin: accountHomeOrigin(origin),
      role: sql`case when ${accounts.administrator} then 2 when exists(select 1 from quiz_game_instance_grants where actor_id = "quiz_game_organization_accounts"."actor_id" ${reportScope}) then 1 else 0 end`,
      sanction: sql`coalesce((select max(case kind when 'ban' then 3 when 'timeout' then 2 else 1 end) from quiz_game_moderation_sanctions where ${activeScope}), 0)`,
      expiresAt: sql`(select min(expires_at) from quiz_game_moderation_sanctions where ${activeScope})`,
      reports: reportCount,
      appeals: appealCount,
    };
    const filter = and(
      eq(accounts.organizationId, ctx.organization.id),
      query
        ? sql`(instr(lower(coalesce(${accountDisplayName},'')), ${query.toLowerCase()})>0
          or instr(lower(${accountHomeOrigin(origin)}), ${query.toLowerCase()})>0)`
        : undefined,
      input.filter === 'restricted'
        ? restricted
        : input.filter === 'reports'
          ? sql`${reportCount}>0`
          : input.filter === 'appeals'
            ? sql`${appealCount}>0`
            : undefined,
    );
    const [{ total }] = await tx
      .select({ total: sql<number>`count(*)` })
      .from(accounts)
      .where(filter);
    const page = Math.min(paging.page, Math.max(1, Math.ceil(total / paging.pageSize)));
    const users = await tx
      .select({
        actorId: accounts.actorId,
        displayName: accountDisplayName,
        origin: accountHomeOrigin(origin),
        withdrawnAt: accounts.withdrawnAt,
        administrator: accounts.administrator,
        reportCount,
        appealCount,
      })
      .from(accounts)
      .where(filter)
      .orderBy(
        orderValue(
          userValues[sorting.sort as keyof typeof userValues],
          sorting.direction,
        ),
        orderValue(accountDisplayName, 'asc'),
        asc(accounts.actorId),
      )
      .limit(paging.pageSize)
      .offset((page - 1) * paging.pageSize);
    const ids = users.map((user) => user.actorId);
    const userGrants = ids.length
      ? await tx
          .select()
          .from(grants)
          .where(
            and(
              sql`${grants.actorId} in (select value from json_each(${JSON.stringify(ids)}))`,
              instanceId ? eq(grants.instanceId, instanceId) : undefined,
            ),
          )
      : [];
    const userSanctions = ids.length
      ? await tx
          .select()
          .from(sanctions)
          .where(
            and(
              sql`${sanctions.actorId} in (select value from json_each(${JSON.stringify(ids)}))`,
              instanceId
                ? or(eq(sanctions.instanceId, instanceId), isNull(sanctions.instanceId))
                : undefined,
            ),
          )
      : [];
    return {
      ...base,
      pagination: { page, pageSize: paging.pageSize, total },
      users: users.map((user) => ({
        ...view(user),
        reportCount: user.reportCount,
        appealCount: user.appealCount,
        permissions: [
          ...new Set(
            userGrants
              .filter((grant) => grant.actorId === user.actorId)
              .map((grant) => grant.permission),
          ),
        ],
        sanctions: userSanctions.filter(
          (sanction) => sanction.actorId === user.actorId && activeSanction(sanction),
        ),
      })),
      next: null,
    };
  });
}
export function sanctionChange(
  input: Record<string, unknown>,
  instanceId: string | null,
  actorId: string,
  operationId: string,
  before: Sanction | null,
): Sanction {
  if (!['add', 'change', 'revoke'].includes(String(input.action)))
    fail('INVALID_SANCTION', 400);
  if (
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 1000
  )
    return fail('REASON_REQUIRED', 400);
  const reason = input.reason.trim();
  if (input.action !== 'add') {
    if (!before) return fail('SANCTION_NOT_FOUND', 404);
    if (before.revision !== input.revision || !activeSanction(before))
      fail('EDIT_CONFLICT', 409);
    if (input.action === 'change' && before.kind === 'ban' && input.kind !== 'ban')
      fail('BAN_REQUIRES_REVOKE', 400);
  }
  if (input.action === 'revoke') {
    if (!before) return fail('SANCTION_NOT_FOUND', 404);
    return {
      ...before,
      revokedAt: new Date().toISOString(),
      reason,
      revision: before.revision + 1,
    };
  }
  let parsed: ReturnType<typeof parseSanction>;
  try {
    parsed = parseSanction(input, instanceId === null);
  } catch (error) {
    throw new OrganizationError((error as Error).message, 400);
  }
  return {
    id: before?.id ?? operationId,
    instanceId,
    actorId,
    ...parsed,
    reason,
    revokedAt: null,
    revision: (before?.revision ?? 0) + 1,
  };
}

export async function mutateSanction(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  const instanceId = input.instanceId === null ? null : validId(input.instanceId);
  const targetId = actor(input.actorId);
  const sanctionScope = input.organizationWide === true ? null : instanceId;
  const operationId = validId(input.operationId);
  const action = input.action;
  if (!['add', 'change', 'revoke'].includes(String(action)))
    fail('INVALID_SANCTION', 400);
  if (
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 1000
  )
    fail('REASON_REQUIRED', 400);
  const reason = (input.reason as string).trim();
  const hash = await contentHash(input);
  return changeD1(db, async (writes) => {
    const tx = db;
    const ctx = await context(tx, subject, instanceId);
    if (sanctionScope === null && !ctx.account.administrator) fail('ADMIN_REQUIRED');
    const target = await targetUser(tx, ctx.organization.id, targetId);
    if (!(await canAct(tx, ctx.account, target))) fail('PROTECTED_ACCOUNT');
    const [existing] = await tx.select().from(events).where(eq(events.id, operationId));
    if (existing) {
      if (existing.operatorId !== ctx.account.actorId || existing.requestHash !== hash)
        fail('OPERATION_CONFLICT', 409);
      return {
        actorId: targetId,
        instanceIds: sanctionScope ? [sanctionScope] : ctx.scopes.map((row) => row.id),
      };
    }
    let before: Sanction | null = null;
    if (action !== 'add') {
      const id = validId(input.id);
      const [row] = await tx
        .select()
        .from(sanctions)
        .where(
          and(
            eq(sanctions.id, id),
            eq(sanctions.organizationId, ctx.organization.id),
            eq(sanctions.actorId, targetId),
            scopeFilter(sanctionScope),
          ),
        );
      if (!row) fail('SANCTION_NOT_FOUND', 404);
      before = row;
    }
    const after = sanctionChange(input, sanctionScope, targetId, operationId, before);
    if (before)
      writes.push(tx.update(sanctions).set(after).where(eq(sanctions.id, before.id)));
    else
      writes.push(
        tx.insert(sanctions).values({ ...after, organizationId: ctx.organization.id }),
      );
    if (action === 'revoke' && before?.kind === 'ban') {
      writes.push(
        tx
          .update(sanctionAppeals)
          .set({
            resolvedAt: new Date().toISOString(),
            operatorId: ctx.account.actorId,
            resolution: reason,
            decision: 'revoke',
            readAt: null,
          })
          .where(
            and(
              eq(sanctionAppeals.sanctionId, before.id),
              isNull(sanctionAppeals.resolvedAt),
            ),
          ),
      );
    }
    writes.push(
      tx.insert(events).values({
        id: operationId,
        organizationId: ctx.organization.id,
        instanceId: sanctionScope,
        actorId: targetId,
        operatorId: ctx.account.actorId,
        action: action as 'add' | 'change' | 'revoke',
        reason,
        requestHash: hash,
        before,
        after,
      }),
    );
    return {
      actorId: targetId,
      instanceIds: sanctionScope ? [sanctionScope] : ctx.scopes.map((row) => row.id),
    };
  });
}
export async function personalModeration(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  if (input.readIds !== undefined) {
    if (!Array.isArray(input.readIds) || input.readIds.length > 5)
      fail('INVALID_NOTIFICATION', 400);
    const ids = (input.readIds as unknown[]).map(validId);
    if (ids.length)
      await changeD1(db, async (writes) => {
        const { organization, account } = await organizationIdentity(db, subject);
        writes.push(
          db
            .update(sanctionAppeals)
            .set({ readAt: new Date().toISOString() })
            .where(
              and(
                eq(sanctionAppeals.actorId, account.actorId),
                inArray(sanctionAppeals.id, ids),
              ),
            ),
        );
        writes.push(
          db
            .update(administratorTransfers)
            .set({ readAt: new Date().toISOString() })
            .where(
              and(
                eq(administratorTransfers.targetId, account.actorId),
                inArray(administratorTransfers.id, ids),
              ),
            ),
        );
        writes.push(
          db
            .update(events)
            .set({ readAt: new Date().toISOString() })
            .where(
              and(
                eq(events.actorId, account.actorId),
                eq(events.organizationId, organization.id),
                inArray(events.id, ids),
              ),
            ),
        );
      });
  }
  return readD1(db, async () => {
    const { organization, account } = await organizationIdentity(db, subject);
    const rows = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.organizationId, organization.id),
          eq(events.actorId, account.actorId),
          sql`${events.action} <> 'inspect'`,
          gt(events.createdAt, new Date(Date.now() - 90 * 86400000).toISOString()),
        ),
      )
      .orderBy(desc(events.createdAt))
      .limit(5);
    const personalAppeals = await db
      .select()
      .from(sanctionAppeals)
      .where(
        and(
          eq(sanctionAppeals.actorId, account.actorId),
          eq(sanctionAppeals.organizationId, organization.id),
        ),
      )
      .orderBy(desc(sanctionAppeals.createdAt));
    const invites = await db
      .select()
      .from(administratorTransfers)
      .where(
        and(
          eq(administratorTransfers.organizationId, organization.id),
          or(
            eq(administratorTransfers.targetId, account.actorId),
            eq(administratorTransfers.senderId, account.actorId),
          ),
        ),
      )
      .orderBy(desc(administratorTransfers.createdAt));
    const names = Object.fromEntries(
      (
        await db
          .select({
            id: accounts.actorId,
            name: sql<string>`case when ${accounts.withdrawnAt} is not null then '退会ユーザー' else ${accountDisplayName} end`,
          })
          .from(accounts)
          .where(eq(accounts.organizationId, organization.id))
      ).map((listedAccount) => [listedAccount.id, listedAccount.name ?? '表示名未登録']),
    );
    return {
      appeals: personalAppeals,
      transfers: invites.map((invitation) => ({
        ...invitation,
        senderName: names[invitation.senderId],
        targetName: names[invitation.targetId],
      })),
      sanctions: (await actorSanctions(db, organization.id, account.actorId)).filter(
        (row) => activeSanction(row),
      ),
      notifications: [
        ...personalAppeals
          .filter(
            (appeal) =>
              appeal.resolvedAt &&
              Date.parse(appeal.resolvedAt) > Date.now() - 90 * 86400000,
          )
          .map((appeal) => ({
            id: appeal.id,
            instanceId: '',
            createdAt: appeal.resolvedAt ?? appeal.createdAt,
            read: !!appeal.readAt,
            message: '異議申し立ての対応結果が届きました。マイページで確認してください。',
            target: { page: 'profile' as const },
          })),
        ...invites
          .filter(
            (invitation) =>
              invitation.targetId === account.actorId &&
              invitation.state === 'pending' &&
              Date.parse(invitation.expiresAt) > Date.now(),
          )
          .map((invitation) => ({
            id: invitation.id,
            instanceId: '',
            createdAt: invitation.createdAt,
            read: !!invitation.readAt,
            message: '管理者引き継ぎの依頼が届きました。マイページで確認してください。',
            target: { page: 'profile' as const },
          })),
        ...rows.map((row) => ({
          id: row.id,
          instanceId: '',
          createdAt: row.createdAt,
          read: !!row.readAt,
          message: `利用制限が${row.action === 'revoke' ? '解除' : row.action === 'change' ? '変更' : '設定'}されました。マイページで理由・期限を確認してください。`,
          target: { page: 'profile' as const },
        })),
      ]
        .sort((leftNotification, rightNotification) =>
          rightNotification.createdAt.localeCompare(leftNotification.createdAt),
        )
        .slice(0, 5),
    };
  });
}

export async function rankingExclusions(
  db: Pick<Database, 'select'>,
  organizationId: string,
  instanceId: string,
) {
  const rows = await db
    .select()
    .from(sanctions)
    .where(
      and(
        eq(sanctions.organizationId, organizationId),
        eq(sanctions.kind, 'ban'),
        or(eq(sanctions.instanceId, instanceId), isNull(sanctions.instanceId)),
      ),
    );
  const retired = await db
    .select({ actorId: accounts.actorId })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        sql`${accounts.withdrawnAt} IS NOT NULL`,
      ),
    );
  return [
    ...new Set([
      ...rows.filter((row) => activeSanction(row)).map((row) => row.actorId),
      ...retired.map((row) => row.actorId),
    ]),
  ];
}
