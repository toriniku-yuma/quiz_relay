export type SortDirection = 'asc' | 'desc';
export type SortState = { sort: string; direction: SortDirection };
export const questionSortKeys = [
  'rate',
  'trials',
  'difficulty',
  'fixed',
  'reports',
  'review',
  'text',
  'answer',
  'status',
  'category',
  'author',
  'updatedAt',
] as const;
export const userSortKeys = [
  'name',
  'origin',
  'role',
  'sanction',
  'expiresAt',
  'reports',
  'appeals',
] as const;
export const eventSortKeys = [
  'createdAt',
  'action',
  'operator',
  'scope',
  'reason',
] as const;
export const investigationSortKeys = [
  'finishedAt',
  'outcome',
  'correct',
  'wrong',
  'timeouts',
  'correctMs',
  'wrongMs',
  'ratingDelta',
] as const;
export function sortInput(
  input: { sort?: unknown; direction?: unknown },
  keys: readonly string[],
  fallback: string,
  direction: SortDirection = 'desc',
): SortState {
  const sort = input.sort ?? fallback;
  const order = input.direction ?? direction;
  if (
    typeof sort !== 'string' ||
    !keys.includes(sort) ||
    (order !== 'asc' && order !== 'desc')
  )
    throw new Error('INVALID_SORT');
  return { sort, direction: order as SortDirection };
}
export function nextSort(
  current: SortState,
  sort: string,
  initial: SortDirection,
): SortState {
  return {
    sort,
    direction:
      current.sort === sort ? (current.direction === 'asc' ? 'desc' : 'asc') : initial,
  };
}
export function compareValues(
  a: string | number | null,
  b: string | number | null,
  direction: SortDirection,
) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const result =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), 'ja');
  return direction === 'asc' ? result : -result;
}
