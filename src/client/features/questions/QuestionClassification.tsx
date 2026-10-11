import { useRef, useState } from 'react';
import type { QuestionOverview } from '../../../shared/questions';
import Button from '../../components/Button';
import Modal from '../../components/Modal';
import { useQuestionOperation } from './useQuestionOperation';
export default function QuestionClassification({
  data,
  instanceId,
  saved,
  open,
  onClose,
}: {
  data: QuestionOverview;
  open: boolean;
  onClose: () => void;
  instanceId: string;
  saved: () => Promise<void>;
}) {
  const [json, setJson] = useState(''),
    [error, setError] = useState('');
  const [preview, setPreview] = useState<
    { id: string; revision: number; categoryId: string }[]
  >([]);
  const model = useQuestionOperation(instanceId, saved);
  const frozen = useRef(data);
  if (!model.uncertain) frozen.current = data;
  data = frozen.current;
  const scope = JSON.stringify([
    instanceId,
    data.submissions.map((row) => [row.id, row.revision]).sort(),
  ]);
  const [previewScope, setPreviewScope] = useState(scope);
  if (!model.uncertain && previewScope !== scope) {
    setPreviewScope(scope);
    setPreview([]);
    setJson('');
    setError('');
  }
  function prepare() {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed) || !parsed.length || parsed.length > 500)
        throw new Error('1〜500件の配列で指定してください。');
      const seen = new Set<string>();
      const next = parsed.map((item: { id?: string; categoryId?: string }) => {
        const row = data.submissions.find((row) => row.id === item.id);
        if (
          !row ||
          seen.has(row.id) ||
          !data.categories.some(
            (category) =>
              category.active && !category.importOnly && category.id === item.categoryId,
          )
        )
          throw new Error('不明・重複した問題IDまたは無効なカテゴリIDがあります。');
        seen.add(row.id);
        return {
          id: row.id,
          revision: row.revision,
          categoryId: item.categoryId as string,
        };
      });
      setPreview(next);
      setError('');
    } catch (error) {
      setPreview([]);
      setError(error instanceof Error ? error.message : 'JSONを確認してください。');
    }
  }

  if (!open) return null;
  return (
    <Modal title="分類用JSON" onClose={onClose} busy={model.busy}>
      <div className="grid gap-3">
        <fieldset disabled={model.busy || model.uncertain} className="grid gap-3">
          <Button
            disabled={!data.submissions.length}
            onClick={() => {
              setJson(
                JSON.stringify(
                  {
                    questions: data.submissions.map((row) => ({
                      id: row.id,
                      text: row.input.text,
                      displayAnswer: row.input.displayAnswer,
                      categoryId: row.input.categoryId,
                    })),
                    categories: data.categories
                      .filter((item) => item.active && !item.importOnly)
                      .map(({ id, name }) => ({ id, name })),
                  },
                  null,
                  2,
                ),
              );
              setPreview([]);
            }}
          >
            選択問題の分類用JSONを表示
          </Button>
          <label className="grid gap-2">
            分類用JSON／読み込む分類結果
            <textarea
              className="min-h-40 border border-line p-3"
              value={json}
              onChange={(event) => {
                setJson(event.target.value);
                setPreview([]);
              }}
              placeholder={'[{"id":"問題ID","categoryId":"移動先ID"}]'}
            />
          </label>
          <Button onClick={prepare}>分類結果を読み込んで変更前後を確認</Button>
          {error && <p role="alert">{error}</p>}
          {preview.map((change) => {
            const row = data.submissions.find((row) => row.id === change.id);
            return (
              <p key={change.id}>
                {row?.input.text}：
                {data.categories.find((item) => item.id === row?.input.categoryId)?.name}{' '}
                → {data.categories.find((item) => item.id === change.categoryId)?.name}
              </p>
            );
          })}
          {!!preview.length && (
            <Button
              disabled={model.busy || model.uncertain}
              onClick={async () => {
                if (
                  await model.submit({
                    operation: 'bulk',
                    action: 'classify',
                    changes: preview,
                    requestId: crypto.randomUUID(),
                  })
                )
                  setPreview([]);
              }}
            >
              確認したカテゴリ変更を一括反映
            </Button>
          )}
        </fieldset>
        {model.error && <p role="alert">{model.error}</p>}
        {model.uncertain && (
          <Button disabled={model.busy} onClick={() => void model.submit({})}>
            同じ内容で再試行
          </Button>
        )}
      </div>
    </Modal>
  );
}
