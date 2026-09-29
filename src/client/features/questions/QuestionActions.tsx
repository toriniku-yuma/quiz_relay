import { useRef, useState } from 'react';
import type { QuestionOverview, Submission } from '../../../shared/questions';
import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import Modal from '../../components/Modal';
import TextField from '../../components/TextField';
import { useQuestionOperation } from './useQuestionOperation';
export default function QuestionActions({
  rows,
  data,
  instanceId,
  open,
  onClose,
  saved,
}: {
  rows: Submission[];
  data: QuestionOverview;
  instanceId: string;
  open: boolean;
  onClose: () => void;
  saved: () => Promise<void>;
}) {
  const [action, setAction] = useState(''),
    [category, setCategory] = useState(''),
    [level, setLevel] = useState('0'),
    [fixed, setFixed] = useState(false),
    [reason, setReason] = useState('');
  const model = useQuestionOperation(instanceId, saved);
  const frozen = useRef(rows);
  if (!model.uncertain) frozen.current = rows;
  rows = frozen.current;
  const identity = rows.map((r) => `${r.id}:${r.revision}`).join('|');
  const [editing, setEditing] = useState(identity);
  if (!model.uncertain && identity !== editing) {
    setEditing(identity);
    setAction('');
    setCategory('');
    setReason('');
    setLevel('0');
    setFixed(false);
  }
  if (!open) return null;
  const deleted = rows.some((r) => r.deletedAt);
  const choices = deleted
    ? { restore: '復元' }
    : {
        classify: 'カテゴリ変更',
        ...(data.administrator ? { difficulty: '難易度変更' } : {}),
        stop: '使用停止',
        resume: '使用停止の解除',
        ...(rows.every((r) => r.status === 'pending' || r.publishedId)
          ? { return: '差戻し' }
          : {}),
        delete: '削除',
        ...(rows.length === 1 && rows[0].status === 'pending'
          ? { approve: '承認', reject: '却下' }
          : {}),
      };
  return (
    <Modal
      title={rows.length === 1 ? '問題の操作' : '問題の一括操作'}
      onClose={onClose}
      busy={model.busy}
    >
      <p>
        対象 {rows.length}件：{rows.map((r) => r.input.text || '未入力').join('、')}
      </p>
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const changes = rows.map((r) => ({
            id: r.id,
            revision: r.revision,
            categoryId: category,
            difficulty: Number(level),
            fixed,
          }));
          const body = {
            operation: 'bulk',
            action,
            changes,
            reason,
            requestId: crypto.randomUUID(),
          };
          if (await model.submit(body)) onClose();
        }}
      >
        <fieldset disabled={model.busy || model.uncertain} className="grid gap-4">
          <label>
            操作
            <select
              className="m-2 border border-line p-3"
              required
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              <option value="">選択してください</option>
              {Object.entries(choices).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {action === 'classify' && (
            <label>
              変更先カテゴリ
              <select
                className="m-2 border border-line p-3"
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">選択してください</option>
                {data.categories
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {action === 'difficulty' && (
            <>
              <label>
                難易度
                <select
                  className="m-2 border border-line p-3"
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                >
                  {['初級', '中級', '上級'].map((s, i) => (
                    <option key={s} value={i}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <Checkbox checked={fixed} onChange={(e) => setFixed(e.target.checked)} />{' '}
                自動更新せず固定する
              </label>
            </>
          )}
          <TextField
            id="question-action-reason"
            label="理由"
            placeholder="例：内容に誤りがあるため"
            required={!['classify', 'approve'].includes(action)}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
          />
        </fieldset>
        {action === 'delete' && (
          <p>通常一覧と出題から外します。削除済み一覧から復元できます。</p>
        )}
        {action === 'restore' && (
          <p>削除直前の状態へ戻します。出題可能だった問題は出題対象に戻ります。</p>
        )}
        {action === 'return' && (
          <p>作問者へ理由を通知し、修正・承認まで出題を停止します。</p>
        )}
        {model.error && <p role="alert">{model.error}</p>}
        {model.uncertain && !model.busy && (
          <p>保存結果が不明なため、同じ内容で再試行してください。</p>
        )}
        <Button
          type="submit"
          disabled={model.busy || (!model.uncertain && !Object.hasOwn(choices, action))}
        >
          {model.busy ? '保存中…' : model.uncertain ? '同じ内容で再試行' : '保存'}
        </Button>
      </form>
    </Modal>
  );
}
