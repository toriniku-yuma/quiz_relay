import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { ModeratedUser } from '../../../shared/moderation';
import {
  type InstancePermission,
  instancePermissions,
  permissionRevision,
} from '../../../shared/organization';
import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import Modal from '../../components/Modal';
import { useMutation } from './useMutation';

const labels = {
  questions: '問題管理・審査',
  authors: '作問者資格管理',
  users: 'ユーザーモデレーション',
};
export default function UserPermissions({
  user,
  instanceId,
  open,
  onClose,
  saved,
}: {
  user: ModeratedUser;
  instanceId: string | null;
  open: boolean;
  onClose: () => void;
  saved: () => Promise<void>;
}) {
  const [permissions, setPermissions] = useState<InstancePermission[]>(
      user.permissions ?? [],
    ),
    [keepSender, setKeepSender] = useState(''),
    [expected, setExpected] = useState(permissionRevision(user.permissions ?? []));
  const mutation = useMutation(API_PATHS.moderationWorkflow, async (request) => {
    if (request.action === 'permissions')
      setExpected(permissionRevision(request.permissions as InstancePermission[]));
    await saved();
  });
  if (!open) return null;
  return (
    <Modal title={`権限設定：${user.name}`} busy={mutation.busy} onClose={onClose}>
      <div className="grid gap-5">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void mutation.submit({
              action: 'permissions',
              instanceId,
              actorId: user.actorId,
              permissions,
              expected,
            });
          }}
        >
          <fieldset
            disabled={mutation.busy || mutation.uncertain || user.administrator}
            className="grid gap-3"
          >
            <legend>このインスタンスのモデレーター権限</legend>
            {instancePermissions.map((p) => (
              <label key={p}>
                <Checkbox
                  checked={permissions.includes(p)}
                  onChange={(e) =>
                    setPermissions(
                      e.target.checked
                        ? [...permissions, p]
                        : permissions.filter((v) => v !== p),
                    )
                  }
                />{' '}
                {labels[p]}
              </label>
            ))}
          </fieldset>
          {user.administrator ? (
            <p>組織管理者はすべての管理権限を持っています。</p>
          ) : (
            <Button type="submit" disabled={mutation.busy || mutation.uncertain}>
              権限を保存
            </Button>
          )}
        </form>
        {!user.administrator && (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void mutation.submit({
                action: 'inviteAdmin',
                actorId: user.actorId,
                keepSender: keepSender === 'keep',
              });
            }}
          >
            <label className="grid gap-2">
              管理者引き継ぎ後の自分の権限
              <select
                required
                disabled={mutation.busy || mutation.uncertain}
                value={keepSender}
                onChange={(e) => setKeepSender(e.target.value)}
                className="h-12 border border-line p-3"
              >
                <option value="">選択してください</option>
                <option value="keep">管理者として残る</option>
                <option value="leave">管理者から外れる</option>
              </select>
            </label>
            <p>
              相手がマイページで承諾すると引き継ぎが成立します。招待の有効期限は7日です。
            </p>
            <Button type="submit" disabled={mutation.busy || mutation.uncertain}>
              管理者引き継ぎを依頼
            </Button>
          </form>
        )}
        {mutation.error && <p role="alert">{mutation.error}</p>}
        {mutation.uncertain && (
          <Button disabled={mutation.busy} onClick={() => void mutation.submit({})}>
            同じ内容で再試行
          </Button>
        )}
      </div>
    </Modal>
  );
}
