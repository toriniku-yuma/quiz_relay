import { type SQLWrapper, sql } from 'drizzle-orm';

export function anonymousAuditReason(reason: SQLWrapper) {
  return sql`case when ${reason} is null then null else '退会に伴い削除' end`;
}

export function anonymousSanction(sanction: SQLWrapper) {
  return sql`case when json_type(${sanction}, '$.reason') is not null then json_set(${sanction}, '$.reason', '退会に伴い削除') else ${sanction} end`;
}

export function anonymousAuditDetails(details: SQLWrapper) {
  return sql`json_object('action', json_extract(${details}, '$.action'), 'redacted', json('true'))`;
}
