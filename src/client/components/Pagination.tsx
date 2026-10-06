import { type Pagination as Page, pageSizes } from '../../shared/pagination';
import Button from './Button';
export default function Pagination({
  value,
  pageSize,
  disabled = false,
  onChange,
}: {
  value?: Page;
  pageSize: number;
  disabled?: boolean;
  onChange: (change: { page?: number; pageSize?: number }) => void;
}) {
  const last = value ? Math.max(1, Math.ceil(value.total / value.pageSize)) : 1;
  return (
    <nav aria-label="一覧のページ移動" className="flex flex-wrap items-center gap-4">
      <label className="flex items-center gap-2">
        1ページの表示件数
        <select
          className="min-h-12 border border-line bg-paper p-2"
          value={pageSize}
          onChange={(event) =>
            onChange({ pageSize: Number(event.target.value), page: 1 })
          }
        >
          {pageSizes.map((optionPageSize) => (
            <option key={optionPageSize} value={optionPageSize}>
              {optionPageSize}件
            </option>
          ))}
        </select>
      </label>
      <span role="status">
        {value
          ? `全${value.total}件${value.total ? `中 ${(value.page - 1) * value.pageSize + 1}〜${Math.min(value.page * value.pageSize, value.total)}件` : ''}`
          : '件数を確認中'}
      </span>
      <Button
        disabled={disabled || !value || value.page <= 1}
        onClick={() => onChange({ page: (value?.page ?? 1) - 1 })}
      >
        前へ
      </Button>
      <span>{value ? `${value.page} / ${last}ページ` : 'ページ数を確認中'}</span>
      <Button
        disabled={disabled || !value || value.page >= last}
        onClick={() => onChange({ page: (value?.page ?? 1) + 1 })}
      >
        次へ
      </Button>
    </nav>
  );
}
