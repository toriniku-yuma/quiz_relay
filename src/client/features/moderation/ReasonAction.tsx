import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import Button from '../../components/Button';
import IconButton from '../../components/IconButton';
import Modal from '../../components/Modal';
import TextField from '../../components/TextField';
import { useMutation } from './useMutation';
export default function ReasonAction({
  title,
  input,
  report = false,
  disabled = false,
}: {
  title: string;
  input: Record<string, unknown>;
  report?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(''),
    [done, setDone] = useState(false);
  const mutation = useMutation(API_PATHS.moderationWorkflow, () => {
    setDone(report);
    setOpen(false);
    setReason('');
  });
  return (
    <>
      {done ? (
        <span role="status">送信しました</span>
      ) : report ? (
        <IconButton
          icon="report"
          label={title}
          disabled={disabled}
          onClick={() => setOpen(true)}
        />
      ) : (
        <Button disabled={disabled} onClick={() => setOpen(true)}>
          {title}
        </Button>
      )}
      {open && (
        <Modal title={title} busy={mutation.busy} onClose={() => setOpen(false)}>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void mutation.submit({ ...input, reason });
            }}
          >
            <TextField
              id="action-reason"
              label="理由"
              placeholder="状況を具体的に入力してください"
              required
              maxLength={1000}
              value={reason}
              disabled={mutation.busy || mutation.uncertain}
              onChange={(e) => setReason(e.target.value)}
            />
            {mutation.error && <p role="alert">{mutation.error}</p>}
            {mutation.uncertain && (
              <p>保存結果を確認できていません。同じ内容で再試行してください。</p>
            )}
            <Button type="submit" disabled={mutation.busy}>
              {mutation.uncertain ? '同じ内容で再試行' : '送信'}
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
