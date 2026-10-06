import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import Button from '../../components/Button';
import IconButton from '../../components/IconButton';
import Modal from '../../components/Modal';
import TextField from '../../components/TextField';
import { useMutation } from '../moderation/useMutation';
import { playRequest } from './api';
export default function PlayReport({
  instanceId,
  title,
  input,
}: {
  instanceId: string;
  title: string;
  input: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(''),
    [sent, setSent] = useState(false),
    [kind, setKind] = useState('defect'),
    [category, setCategory] = useState('');
  const mutation = useMutation(
    API_PATHS.playReport,
    () => {
      setSent(true);
      setOpen(false);
    },
    (path, body) => playRequest(path, body, instanceId),
  );
  return (
    <>
      {sent ? (
        <span>通報済み</span>
      ) : (
        <IconButton icon="report" label={title} onClick={() => setOpen(true)} />
      )}
      {open && (
        <Modal
          title={title}
          onClose={() => setOpen(false)}
          busy={mutation.busy || mutation.uncertain}
        >
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void mutation.submit({
                ...input,
                reason,
                ...(input.action === 'question'
                  ? { kind, suggestedCategory: category }
                  : {}),
              });
            }}
          >
            <fieldset
              className="grid gap-3"
              disabled={mutation.busy || mutation.uncertain}
            >
              {input.action === 'question' && (
                <>
                  <label>
                    通報種別
                    <select
                      className="ml-3 border border-line p-3"
                      value={kind}
                      onChange={(event) => setKind(event.target.value)}
                    >
                      <option value="defect">問題不備</option>
                      <option value="category">カテゴリ違い</option>
                    </select>
                  </label>
                  {kind === 'category' && (
                    <TextField
                      id="play-report-category"
                      label="提案カテゴリ（任意）"
                      placeholder="例：地理"
                      maxLength={80}
                      value={category}
                      onChange={(event) => setCategory(event.target.value)}
                    />
                  )}
                </>
              )}
              <TextField
                id="play-report-reason"
                label="理由（必須）"
                placeholder="状況を具体的に入力してください"
                required
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </fieldset>
            {mutation.error && <p role="alert">{mutation.error}</p>}
            {mutation.uncertain && (
              <p>通信結果が不明です。同じ内容で再試行してください。</p>
            )}
            <Button type="submit" disabled={mutation.busy}>
              {mutation.uncertain ? '同じ内容で再試行' : '通報する'}
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
