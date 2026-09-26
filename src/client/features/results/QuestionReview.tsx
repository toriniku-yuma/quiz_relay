import { useState } from 'react';
import type { ResultsOverview } from '../../../shared/results';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import { questionsRequest } from '../questions/useQuestions';

export default function QuestionReview({
  questions,
  resultId,
  instanceId,
}: {
  questions: NonNullable<ResultsOverview['history'][number]['questions']>;
  resultId: string;
  instanceId: string;
}) {
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState('defect');
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <details className="mt-3 border border-line p-3">
      <summary className="cursor-pointer font-bold">
        出題済み問題を振り返る（{questions.length}問）
      </summary>
      <ul className="grid gap-4 pt-3">
        {questions.map((q) => (
          <li key={q.id} className="border border-line p-3">
            <p>{q.text}</p>
            <p className="font-bold">
              {q.displayAnswer}（{q.readings.join('・')}）
            </p>
            <p>{q.explanation}</p>
            <p className="break-words">{q.source}</p>
            {q.authorName && <p>作問：{q.authorName}</p>}
            <Button
              disabled={busy}
              onClick={() => {
                setTarget(q.id);
                setMessage('');
              }}
            >
              この問題を通報
            </Button>
          </li>
        ))}
      </ul>
      {target && (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage('');
            try {
              await questionsRequest(instanceId, {
                operation: 'report',
                resultId,
                questionId: target,
                kind,
                reason,
                suggestedCategory: category,
              });
              setMessage('通報を受け付けました。提出後の編集・取消はできません。');
              setTarget('');
              setReason('');
            } catch (error) {
              setMessage(
                error instanceof Error ? error.message : '通報できませんでした。',
              );
            } finally {
              setBusy(false);
            }
          }}
          className="mt-4 grid gap-3"
        >
          <label>
            通報種別
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="ml-3 border border-line p-2"
            >
              <option value="defect">問題不備</option>
              <option value="category">カテゴリ違い</option>
            </select>
          </label>
          <TextField
            id={`report-reason-${resultId}`}
            label="理由（必須）"
            placeholder="例：正答として別の読みも成立します"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
          {kind === 'category' && (
            <TextField
              id={`report-category-${resultId}`}
              label="正しいと思うカテゴリ（任意）"
              placeholder="例：地理"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          )}
          <Button type="submit" disabled={busy || !reason.trim()}>
            理由付きで通報する
          </Button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
