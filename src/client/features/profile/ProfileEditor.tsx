import type { Profile } from '../../../shared/profile';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import { useProfile } from './useProfile';

export default function ProfileEditor({ initial }: { initial: Profile }) {
  const model = useProfile(initial);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void model.save();
      }}
    >
      {!initial.displayName && (
        <p role="status">
          認証は完了しています。表示名を登録して利用を開始してください。
        </p>
      )}
      <p>
        表示名はこの組織内で共通です。前後の空白・全角英数字などを揃えて保存し、同じ名前は登録できません。
      </p>
      <TextField
        id="profile-name"
        label="表示名（1〜32文字）"
        placeholder="例：クイズ太郎"
        autoComplete="nickname"
        value={model.name}
        onChange={(event) => model.setName(event.target.value)}
        required
      />
      <p className="text-sm text-muted">
        プロフィールとランキングは現在の名前を表示します。作問者名は次の試合から反映し、参加中の試合と過去の結果は当時の名前を保持します。
      </p>
      {model.error && <p role="alert">{model.error}</p>}
      {model.message && <p role="status">{model.message}</p>}
      <Button type="submit" tone="primary" disabled={model.busy}>
        表示名を保存
      </Button>
    </form>
  );
}
