import { instancePermissions } from '../../../shared/organization';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import { useInstanceGrants } from './useInstanceGrants';
import type { useOrganization } from './useOrganization';

const labels = {
  questions: '作問管理・問題承認',
  authors: '作問者資格の付与・取消',
  users: 'ユーザーモデレーション',
};
export default function InstanceGrants({
  instanceId,
  organization,
}: {
  instanceId: string;
  organization: ReturnType<typeof useOrganization>;
}) {
  const editor = useInstanceGrants(instanceId, organization);
  return (
    <form
      className="mt-5 border-t border-line pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (editor.verified) void editor.save();
      }}
    >
      <h4 className="font-bold">運営担当者の権限設定（任意）</h4>
      <p className="mt-3">
        このインスタンスの運営権限を付与します。組織管理者への設定は不要です。
      </p>
      <TextField
        id={`actor-${instanceId}`}
        label="権限を設定するユーザーの識別子"
        placeholder="本人から受け取った64文字の識別子を貼り付け"
        value={editor.actorId}
        disabled={editor.busy}
        pattern="[0-9a-f]{64}"
        maxLength={64}
        required
        onChange={(event) => editor.changeActor(event.target.value)}
      />
      <Button
        onClick={editor.lookup}
        disabled={editor.busy || !/^[0-9a-f]{64}$/.test(editor.actorId)}
      >
        対象と権限を確認
      </Button>
      {editor.error && <p role="alert">{editor.error}</p>}
      {editor.verified && (
        <>
          <p className="my-3 break-all">
            変更対象：<code>{editor.verified}</code>
          </p>
          <fieldset disabled={editor.busy} className="my-4 grid gap-3">
            <legend className="mb-2 font-semibold">このインスタンスの担当権限</legend>
            {instancePermissions.map((permission) => (
              <label key={permission} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={editor.permissions.includes(permission)}
                  onChange={(event) =>
                    editor.setPermissions((current) =>
                      event.target.checked
                        ? [...current, permission]
                        : current.filter((p) => p !== permission),
                    )
                  }
                />
                {labels[permission]}
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={editor.busy}>
            権限を保存
          </Button>
        </>
      )}
    </form>
  );
}
