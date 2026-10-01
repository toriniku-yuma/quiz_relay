import type { OrganizationOverview } from '../../../shared/organization';
import Button from '../../components/Button';
import TextField from '../../components/TextField';
import { useDeletion } from './useDeletion';
import type { useOrganization } from './useOrganization';

export default function InstanceDeletion({
  instance,
  organization,
}: {
  instance: OrganizationOverview['instances'][number];
  organization: ReturnType<typeof useOrganization>;
}) {
  const model = useDeletion(organization.refresh);
  if (!organization.data?.account?.administrator || instance.state !== 'archived')
    return <p>アーカイブ済みインスタンスの管理者だけが完全削除できます。</p>;
  return (
    <section className="grid gap-4">
      <p>
        このインスタンスの問題・設定・結果・レート・権限・対戦部屋を完全に削除します。元に戻せません。
      </p>
      <p>
        組織共通アカウントと他のインスタンスのデータは残ります。必要な問題は先にエクスポートしてください。進行中の試合・未保存の結果がある間は削除できません。
      </p>
      <dl>
        <dt className="font-bold">対象名</dt>
        <dd>{instance.name}</dd>
        <dt className="mt-3 font-bold">インスタンスID</dt>
        <dd className="break-all">{instance.id}</dd>
      </dl>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void model.mutation.submit({
            id: instance.id,
            name: model.name,
            revision: instance.operationRevision ?? 0,
          });
        }}
      >
        <TextField
          id="instance-delete-name"
          label="確認のため対象名を入力してください"
          placeholder={instance.name}
          value={model.name}
          onChange={(event) => model.setName(event.target.value)}
          disabled={model.mutation.busy || model.mutation.uncertain}
        />
        <Button
          type="submit"
          disabled={model.mutation.busy || model.name !== instance.name}
        >
          {model.mutation.busy
            ? '削除中…'
            : model.mutation.uncertain
              ? '同じ内容で再試行'
              : '完全に削除する'}
        </Button>
      </form>
      {model.mutation.error && <p role="alert">{model.mutation.error}</p>}
      {model.mutation.uncertain && (
        <p>処理状況を確認できません。同じ内容で再試行してください。</p>
      )}
      <a className="underline" href={`/game/?view=closure&instance=${instance.id}`}>
        アーカイブ後の手続きへ戻る
      </a>
    </section>
  );
}
