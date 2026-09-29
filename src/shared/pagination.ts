export const pageSizes = [10, 30, 100] as const;
export type Pagination = { page: number; pageSize: number; total: number };
export function paginationInput(input: { page?: unknown; pageSize?: unknown }) {
  const page = input.page ?? 1,
    pageSize = input.pageSize ?? 10;
  if (
    !Number.isSafeInteger(page) ||
    Number(page) < 1 ||
    !(pageSizes as readonly unknown[]).includes(pageSize)
  )
    throw new Error('INVALID_PAGE');
  return { page: Number(page), pageSize: Number(pageSize) };
}
