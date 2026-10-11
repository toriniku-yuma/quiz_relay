import { useState } from 'react';
import type { QuestionOverview, Submission } from '../../../shared/questions';
import Button from '../../components/Button';
import TextField from '../../components/TextField';

export default function QuestionCategoryRequest({
  data,
  row,
  busy,
  mutate,
}: {
  data: QuestionOverview;
  row: Submission;
  busy: boolean;
  mutate: (body: object) => Promise<boolean>;
}) {
  const [category, setCategory] = useState('');
  const [reason, setReason] = useState('');
  const pending = data.categoryRequests.find(
    (request) => request.submissionId === row.id,
  );
  return (
    <div className="mt-4 grid gap-3 border border-line p-4">
      <h3 className="font-bold">カテゴリだけの変更申請</h3>
      <p>本文の改訂審査と別に扱い、運営が確定します。</p>
      {pending && (
        <p>
          申請中：
          {data.categories.find((category) => category.id === pending.categoryId)?.name}{' '}
          {pending.reason}
        </p>
      )}
      <label>
        希望カテゴリ
        <select
          className="m-2 border border-line p-2"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="">選択してください</option>
          {data.categories
            .filter((item) => item.active && !item.importOnly)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      <TextField
        id="category-request-reason"
        label="カテゴリ変更の理由（任意）"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        disabled={busy || !category}
        onClick={() => {
          void mutate({
            operation: 'request-category',
            id: row.id,
            revision: row.revision,
            categoryId: category,
            reason,
          });
        }}
      >
        カテゴリ変更を申請
      </Button>
    </div>
  );
}
