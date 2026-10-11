import { type SQLWrapper, sql } from 'drizzle-orm';
import { organizationAccounts } from '../worker/db/schema.ts';

export function withdrawnAudit(actors: SQLWrapper[], details?: SQLWrapper) {
  const involved = actors.map((actor) => sql`${organizationAccounts.actorId} = ${actor}`);
  if (details)
    involved.push(
      sql`json_extract(${details}, '$.actorId') = ${organizationAccounts.actorId} or exists(select 1 from json_each(${details}, '$.targets') target where target.value = ${organizationAccounts.actorId} or json_extract(case when target.type = 'object' then target.value else '{}' end, '$.actorId') = ${organizationAccounts.actorId})`,
    );
  return sql`exists(select 1 from ${organizationAccounts} where ${organizationAccounts.withdrawnAt} is not null and (${sql.join(involved, sql` or `)}))`;
}

export function anonymousAuditReason(reason: SQLWrapper) {
  return sql`case when ${reason} is null then null else '退会に伴い削除' end`;
}

export function anonymousSanction(sanction: SQLWrapper) {
  return sql`case when json_type(${sanction}, '$.reason') is not null then json_set(${sanction}, '$.reason', '退会に伴い削除') else ${sanction} end`;
}

export function anonymousAuditDetails(details: SQLWrapper) {
  return sql`json_object('action', json_extract(${details}, '$.action'), 'redacted', json('true'))`;
}
