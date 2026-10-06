import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import Button from '../../components/Button';
import Modal from '../../components/Modal';
import TextField from '../../components/TextField';
import { useMutation } from '../moderation/useMutation';
import { playRequest } from './api';

export default function GuestName({
  name = '',
  onSaved,
  onClose,
}: {
  name?: string;
  onSaved: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(name);
  const mutation = useMutation(API_PATHS.guest, onSaved, playRequest);
  return (
    <Modal
      title="ゲストの表示名"
      onClose={onClose}
      busy={mutation.busy || mutation.uncertain}
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void mutation.submit({ name: value });
        }}
      >
        <TextField
          id="guest-name"
          label="表示名"
          placeholder="例：クイズ太郎"
          autoComplete="nickname"
          required
          maxLength={24}
          value={value}
          disabled={mutation.busy || mutation.uncertain}
          onChange={(event) => setValue(event.target.value)}
        />
        <p>このブラウザーで使います。後からオプションで変更できます。</p>
        {mutation.error && <p role="alert">{mutation.error}</p>}
        {mutation.uncertain && (
          <p>保存結果を確認できていません。同じ内容で再試行してください。</p>
        )}
        <Button type="submit" disabled={mutation.busy}>
          {mutation.uncertain ? '同じ内容で再試行' : '保存'}
        </Button>
      </form>
    </Modal>
  );
}
