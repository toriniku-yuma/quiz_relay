import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import DataTable from '../src/client/components/DataTable';
import { compareValues, nextSort, sortInput } from '../src/shared/sorting';

it('列変更は列の初期方向、同じ列は反転し、欠損値は常に最後になる', () => {
  const current = { sort: 'name', direction: 'asc' as const };
  expect(nextSort(current, 'name', 'asc')).toEqual({ sort: 'name', direction: 'desc' });
  expect(nextSort(current, 'count', 'desc')).toEqual({
    sort: 'count',
    direction: 'desc',
  });
  expect([null, 2, 1].sort((a, b) => compareValues(a, b, 'asc'))).toEqual([1, 2, null]);
  expect([null, 2, 1].sort((a, b) => compareValues(a, b, 'desc'))).toEqual([2, 1, null]);
  expect(sortInput({}, ['name'], 'name')).toEqual({ sort: 'name', direction: 'desc' });
  expect(() => sortInput({ sort: 'unknown' }, ['name'], 'name')).toThrow('INVALID_SORT');
  expect(() => sortInput({ direction: 'invalid' }, ['name'], 'name')).toThrow(
    'INVALID_SORT',
  );
  const html = renderToStaticMarkup(
    createElement(DataTable, {
      label: '一覧',
      columns: [
        { label: '名前', key: 'name' },
        { label: '件数', key: 'count', initial: 'desc' },
        '操作',
      ],
      sorting: current,
      onSort: () => {},
      // biome-ignore lint/correctness/noChildrenProp: createElement の必須props型を満たす。
      children: null,
    }),
  );
  expect(html).toContain('aria-sort="ascending"');
  expect(html).toContain('aria-label="名前で降順に並べ替え"');
  expect(html).toContain('aria-label="件数で降順に並べ替え"');
  expect(html.match(/<button/g)).toHaveLength(2);
});
