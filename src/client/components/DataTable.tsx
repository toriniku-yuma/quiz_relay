import type { ReactNode } from 'react';
import { nextSort, type SortDirection, type SortState } from '../../shared/sorting';
export default function DataTable({
  columns,
  children,
  label,
  sorting,
  onSort,
  busy = false,
  selection,
}: {
  columns: (string | { label: string; key: string; initial?: SortDirection })[];
  sorting?: SortState;
  busy?: boolean;
  selection?: ReactNode;
  onSort?: (value: SortState) => void;
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="min-w-0 max-w-full overflow-x-auto">
      <table
        aria-label={label}
        aria-busy={busy}
        className="w-max min-w-full border-collapse text-left text-sm [&_th]:whitespace-nowrap [&_th]:border-b-2 [&_th]:border-line [&_th]:bg-key [&_th]:px-3 [&_th]:py-3 [&_td]:border-b [&_td]:border-line [&_td]:px-3 [&_td]:py-3 [&_td]:align-middle"
      >
        <thead>
          <tr>
            {selection && <th scope="col">{selection}</th>}
            {columns.map((columnDefinition) => {
              const column =
                typeof columnDefinition === 'string'
                  ? { label: columnDefinition, key: '' }
                  : columnDefinition;
              const selected = sorting?.sort === column.key;
              return (
                <th
                  key={column.label}
                  scope="col"
                  aria-sort={
                    column.key && sorting
                      ? selected
                        ? sorting.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                      : undefined
                  }
                >
                  {column.key && sorting && onSort ? (
                    <button
                      type="button"
                      disabled={busy}
                      className="flex min-h-11 w-full items-center gap-2 text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      onClick={() =>
                        onSort(nextSort(sorting, column.key, column.initial ?? 'asc'))
                      }
                      aria-label={
                        column.label +
                        'で' +
                        (selected
                          ? sorting.direction === 'asc'
                            ? '降順'
                            : '昇順'
                          : column.initial === 'desc'
                            ? '降順'
                            : '昇順') +
                        'に並べ替え'
                      }
                    >
                      {column.label}
                      <svg
                        className="size-5 shrink-0"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path
                          d="m4 6 4-3 4 3"
                          className={
                            selected && sorting.direction === 'asc'
                              ? 'text-ink'
                              : 'text-ink/30'
                          }
                        />
                        <path
                          d="m4 10 4 3 4-3"
                          className={
                            selected && sorting.direction === 'desc'
                              ? 'text-ink'
                              : 'text-ink/30'
                          }
                        />
                      </svg>
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
