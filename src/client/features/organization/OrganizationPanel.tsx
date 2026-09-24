import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { canAccessInstance } from '../../../shared/organization';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import InstanceGrants from './InstanceGrants';
import type { useOrganization } from './useOrganization';

export default function OrganizationPanel({
  organization,
  management = false,
  instanceId,
}: {
  organization: ReturnType<typeof useOrganization>;
  management?: boolean;
  instanceId?: string;
}) {
  const { data, error, busy, mutate, refresh } = organization;
  const [name, setName] = useState('');
  const [initialInstanceName, setInitialInstanceName] = useState('');
  const [instanceName, setInstanceName] = useState('');
  return (
    <section className="grid gap-5">
      {error && (
        <p role="alert" className="border border-accent p-3">
          {error}
        </p>
      )}
      {management && !instanceId && data?.account && (
        <Panel title="本人確認用の識別子">
          <p>権限を依頼するときは、この識別子を管理者へ伝えてください。</p>
          <code className="block break-all select-all">{data.account.actorId}</code>
        </Panel>
      )}
      {management && (
        <p>再読み込みすると、変更された項目の未保存入力はリセットされます。</p>
      )}
      <Button onClick={refresh} disabled={busy}>
        一覧を再読み込み
      </Button>
      {!data ? (
        <p role="status">組織情報を確認しています。</p>
      ) : data.setup ? (
        <Panel title="初回管理者設定">
          <p className="mt-3">
            ログイン中の本人識別子：
            <code className="break-all">{data.setup.subject}</code>
          </p>
          <p className="mt-3">
            設置者はサーバーの INITIAL_ADMIN_SUBJECT
            にこの識別子を設定してください。DBパスワードの入力は不要です。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(API_PATHS.organizationSetup, {
                name,
                instanceName: initialInstanceName,
              });
            }}
          >
            <TextField
              id="organization-name"
              label="組織名"
              placeholder="例：クイズ研究会"
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <TextField
              id="initial-instance-name"
              label="最初のインスタンス名"
              placeholder="例：競技クイズ"
              required
              maxLength={80}
              value={initialInstanceName}
              onChange={(event) => setInitialInstanceName(event.target.value)}
            />
            <Button type="submit" tone="primary" disabled={busy || !data.setup.eligible}>
              初回設定を完了する
            </Button>
          </form>
        </Panel>
      ) : (
        <>
          <Panel title={data.organization?.name ?? 'インスタンス'}>
            <p className="my-3">インスタンスを選んで利用できます。</p>
            {data.instances.length === 0 && <p>公開中のインスタンスはありません。</p>}
            <ul className="grid gap-4">
              {data.instances
                .filter((instance) => !instanceId || instance.id === instanceId)
                .map((instance) => (
                  <li key={instance.id} className="border border-line p-4">
                    <h3 className="font-bold">{instance.name}</h3>
                    <p className="my-2">
                      {instance.state === 'published' ? '公開中' : '準備中'}
                    </p>
                    {canAccessInstance(instance, data.account?.administrator) && (
                      <a
                        className="underline"
                        href={`/game/?instance=${encodeURIComponent(instance.id)}`}
                      >
                        対戦する
                      </a>
                    )}
                    {instance.state === 'preparing' && (
                      <>
                        <p className="my-2">
                          公開前に問題の登録・停止状態・出題設定を確認してください。問題と戦績は他のインスタンスから自動コピーされません。
                        </p>
                        {management && data.account?.administrator && (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              mutate(API_PATHS.organizationPublish, { id: instance.id })
                            }
                          >
                            公開開始
                          </Button>
                        )}
                      </>
                    )}
                    {management &&
                      (data.account?.administrator ||
                        instance.permissions.length > 0) && (
                        <p className="my-3">
                          出題できない場合は、問題の登録・停止状態と出題設定を確認してください。カタログ管理の対象ID：
                          <code className="break-all">{instance.id}</code>
                        </p>
                      )}
                    {management && data.account?.administrator && (
                      <form
                        key={instance.name}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const name = new FormData(event.currentTarget).get('name');
                          void mutate(API_PATHS.organizationRename, {
                            id: instance.id,
                            name,
                            expectedName: instance.name,
                          });
                        }}
                      >
                        <TextField
                          id={`name-${instance.id}`}
                          name="name"
                          label="インスタンス名"
                          placeholder="例：早押しクイズ"
                          defaultValue={instance.name}
                          required
                          maxLength={80}
                        />
                        <Button type="submit" disabled={busy}>
                          名前を保存
                        </Button>
                      </form>
                    )}
                    {management && data.account?.administrator && (
                      <InstanceGrants
                        key={`${instance.id}:${organization.version}`}
                        instanceId={instance.id}
                        organization={organization}
                      />
                    )}
                  </li>
                ))}
            </ul>
          </Panel>
          {management && !instanceId && data.account?.administrator && (
            <Panel title="インスタンスを追加">
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (
                    await mutate(API_PATHS.organizationAdd, {
                      name: instanceName,
                    })
                  ) {
                    setInstanceName('');
                  }
                }}
              >
                <TextField
                  id="instance-name"
                  label="インスタンス名"
                  placeholder="例：早押しクイズ"
                  required
                  maxLength={80}
                  value={instanceName}
                  onChange={(event) => setInstanceName(event.target.value)}
                />
                <Button type="submit" tone="primary" disabled={busy}>
                  準備中として追加
                </Button>
              </form>
            </Panel>
          )}
          {management && !instanceId && data.accounts && (
            <Panel title="組織のアカウント">
              {data.nextAccountCursor && (
                <Button onClick={organization.moreAccounts} disabled={busy}>
                  次の100件を表示
                </Button>
              )}
              <ul className="mt-3 grid gap-2">
                {data.accounts.map((account) => (
                  <li key={account.actorId} className="break-all">
                    <code>{account.actorId}</code>：
                    {account.administrator ? '管理者' : '共通ユーザー'}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </section>
  );
}
