import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { gameHref } from '../../app/navigation';
import { FEDERATION_PATH, USERS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import type { useOrganization } from './useOrganization';

export default function OrganizationSettings({
  organization,
}: {
  organization: ReturnType<typeof useOrganization>;
}) {
  const { data, busy, mutate } = organization;
  const [instanceName, setInstanceName] = useState('');
  if (!data?.organization || !data.account?.administrator) return null;
  return (
    <div className="grid gap-5">
      <Panel title="組織の名前">
        <form
          key={data.organization.name}
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(API_PATHS.organizationSettings, {
              name: new FormData(event.currentTarget).get('name'),
              expectedName: data.organization?.name,
            });
          }}
        >
          <TextField
            id="organization-name"
            name="name"
            label="組織名"
            placeholder="例：クイズ研究会"
            defaultValue={data.organization.name}
            required
            maxLength={80}
          />
          <Button type="submit" disabled={busy} className="justify-self-start">
            名前を保存
          </Button>
        </form>
      </Panel>
      <Panel title="組織の管理">
        <div className="flex flex-wrap gap-4">
          <a className="underline" href={FEDERATION_PATH}>
            外部組織との連携
          </a>
          <a className="underline" href={USERS_PATH}>
            ユーザー管理
          </a>
        </div>
      </Panel>
      <Panel title="インスタンス一覧・作成">
        <p className="my-3">
          対戦・問題・公開状態は、それぞれのインスタンス設定で管理します。
        </p>
        <ul className="grid gap-3">
          {data.instances.map((instance) => (
            <li
              key={instance.id}
              className="flex flex-wrap items-center justify-between gap-3 border border-line p-4"
            >
              <div>
                <strong>{instance.name}</strong>
                <p>
                  {instance.state === 'published'
                    ? '公開中'
                    : instance.state === 'archived'
                      ? 'アーカイブ済み'
                      : '準備中'}
                </p>
              </div>
              <a className="underline" href={gameHref(instance.id, 'settings')}>
                インスタンス設定を開く
              </a>
            </li>
          ))}
        </ul>
        <form
          className="mt-5 grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await mutate(API_PATHS.organizationAdd, { name: instanceName }))
              setInstanceName('');
          }}
        >
          <TextField
            id="instance-name"
            label="新しいインスタンス名"
            placeholder="例：早押しクイズ"
            required
            maxLength={80}
            value={instanceName}
            onChange={(event) => setInstanceName(event.target.value)}
          />
          <Button
            type="submit"
            tone="primary"
            disabled={busy}
            className="justify-self-start"
          >
            準備中として作成
          </Button>
        </form>
      </Panel>
    </div>
  );
}
