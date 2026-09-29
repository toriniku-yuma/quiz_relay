import { useState } from 'react';
import { parseQuestionJson, readQuestionJson } from '../../../shared/question-json';
import { parseTransfer, type TransferQuestion } from '../../../shared/question-transfer';
import type { QuestionOverview } from '../../../shared/questions';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import { useQuestionOperation } from './useQuestionOperation';
export default function QuestionImport({
  instanceId,
  data,
  canSubmit,
  saved,
}: {
  instanceId: string;
  data: QuestionOverview;
  canSubmit: boolean;
  saved: () => Promise<void>;
}) {
  const [source, setSource] = useState(''),
    [rows, setRows] = useState<TransferQuestion[]>([]),
    [count, setCount] = useState(0),
    [mapping, setMapping] = useState<Record<string, { id?: string; name?: string }>>({}),
    [error, setError] = useState(''),
    [done, setDone] = useState(false);
  const model = useQuestionOperation(instanceId, saved);
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await model.submit({
            operation: rows.length ? 'import-transfer' : 'import',
            source,
            mapping,
            requestId: crypto.randomUUID(),
          })
        ) {
          setDone(true);
          setSource('');
          setRows([]);
          setCount(0);
        }
      }}
    >
      <fieldset
        disabled={!canSubmit || model.busy || model.uncertain}
        className="grid gap-4"
      >
        <label className="grid gap-2">
          JSONを下書きとして取り込む（500問・2MB以内）
          <input
            type="file"
            accept=".json,application/json"
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (!file) return;
              setError('');
              setDone(false);
              setSource('');
              setRows([]);
              setCount(0);
              try {
                if (file.size > 2000000)
                  throw Error('2MB以内のファイルを選んでください。');
                const text = await file.text();
                const value = readQuestionJson(text) as { version?: number };
                if (value?.version === 2) {
                  const next = parseTransfer(text);
                  setRows(next);
                  setCount(next.length);
                  setMapping(
                    Object.fromEntries(
                      [...new Set(next.map((r) => r.category))].map((name) => [
                        name,
                        {
                          id:
                            data.categories.find((c) => c.active && c.name === name)
                              ?.id ?? '',
                        },
                      ]),
                    ),
                  );
                } else {
                  setCount(parseQuestionJson(text).length);
                }
                setSource(text);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </label>
        {Object.entries(rows.length ? mapping : {}).map(([name, dest]) => (
          <div key={name} className="grid gap-2 border border-line p-3">
            <label>
              元カテゴリ：{name || '未設定'} → 取込先
              <select
                required
                className="m-2 border border-line p-3"
                value={dest.name !== undefined ? 'new' : dest.id}
                onChange={(e) =>
                  setMapping({
                    ...mapping,
                    [name]: e.target.value === 'new' ? { name } : { id: e.target.value },
                  })
                }
              >
                <option value="">選択してください</option>
                {data.categories
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                {data.administrator && <option value="new">新しいカテゴリを作成</option>}
              </select>
            </label>
            {dest.name !== undefined && (
              <TextField
                id={`import-category-${name}`}
                label="新しいカテゴリ名"
                placeholder="例：自然科学"
                required
                maxLength={80}
                value={dest.name}
                onChange={(e) =>
                  setMapping({ ...mapping, [name]: { name: e.target.value } })
                }
              />
            )}
          </div>
        ))}
        {count > 0 && (
          <p>
            {count}
            問を新しい下書きとして取り込みます。作問者名・出力元・停止状態を保持し、提出後はこのインスタンスの審査ルールに従います。
          </p>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {model.error && <p role="alert">{model.error}</p>}
      {done && <p role="status">下書きとして取り込みました。</p>}
      {model.uncertain && (
        <p>保存結果が不明です。入力を保持したまま同じ内容で再試行できます。</p>
      )}
      <Button type="submit" disabled={!canSubmit || model.busy || !source}>
        {model.uncertain ? '同じ内容で再試行' : '取り込む'}
      </Button>
    </form>
  );
}
