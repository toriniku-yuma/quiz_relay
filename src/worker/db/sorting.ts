import { type SQLWrapper, sql } from 'drizzle-orm';
import type { SortDirection } from '../../shared/sorting.ts';
export function orderValue(value: SQLWrapper, direction: SortDirection) {
  return direction === 'asc'
    ? sql`${value} asc nulls last`
    : sql`${value} desc nulls last`;
}
