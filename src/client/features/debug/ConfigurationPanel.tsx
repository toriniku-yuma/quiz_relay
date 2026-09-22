import Button from '../../components/Button';
import Panel from '../../components/Panel';
import type { useConfigurationStatus } from './useConfigurationStatus';

export default function ConfigurationPanel({
  status,
}: {
  status: ReturnType<typeof useConfigurationStatus>;
}) {
  const { data, busy, error, refresh } = status;
  const organization = data?.organization;
  return (
    <Panel title="現在の組織・インスタンス設定">
      <p className="my-3">
        この画面の接続先について、ログイン本人の権限で確認した設定です。
      </p>
      <Button onClick={refresh} disabled={busy}>
        設定を再確認
      </Button>
      {busy ? (
        <p className="mt-3" role="status">
          設定を確認しています。
        </p>
      ) : error ? (
        <p className="mt-3" role="alert">
          {error}
        </p>
      ) : !data ? (
        <p className="mt-3" role="status">
          ログインすると組織名・インスタンス名・管理者権限を確認できます。
        </p>
      ) : (
        <div className="mt-4 grid gap-3">
          <dl className="grid gap-2 break-words">
            <div>
              <dt className="font-bold">ログイン中の名前</dt>
              <dd>{data.name}</dd>
            </div>
            <div>
              <dt className="font-bold">オーガナイゼーション名</dt>
              <dd>
                {organization?.organization?.name ??
                  (organization?.enabled ? '未設定' : '組織機能が無効です')}
              </dd>
            </div>
            <div>
              <dt className="font-bold">管理者設定</dt>
              <dd>
                {organization?.setup
                  ? '未完了'
                  : organization?.account
                    ? organization.account.administrator
                      ? 'このアカウントは組織管理者です'
                      : 'このアカウントは組織管理者ではありません'
                    : '確認できません'}
              </dd>
            </div>
            {organization?.account?.administrator && (
              <div>
                <dt className="font-bold">管理者名（ログイン本人）</dt>
                <dd>{data.name}</dd>
              </div>
            )}
            {organization?.account && (
              <div>
                <dt className="font-bold">本人識別子</dt>
                <dd className="break-all select-all">{organization.account.actorId}</dd>
              </div>
            )}
          </dl>
          <p className="text-sm">
            名前はログインアカウントの表示名（未登録ならメールアドレス）です。管理者権限は組織DBの設定で確認しています。
          </p>
          {organization?.setup && (
            <p role="status">
              {organization.setup.eligible
                ? 'このアカウントで初回管理者設定を完了できます。'
                : '初回管理者が未設定です。組織設定画面で設置者の指定を確認してください。'}
            </p>
          )}
          {organization?.organization && (
            <>
              <h3 className="font-bold">確認できるインスタンス</h3>
              {organization.instances.length === 0 ? (
                <p>このアカウントで確認できるインスタンスはありません。</p>
              ) : (
                <ul className="grid gap-3">
                  {organization.instances.map((instance) => (
                    <li key={instance.id} className="border border-line p-3">
                      <p className="font-bold break-words">{instance.name}</p>
                      <p>{instance.state === 'published' ? '公開中' : '準備中'}</p>
                      <p className="text-sm break-all">ID：{instance.id}</p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-sm">
                一覧が表示されても、問題・出題設定や対戦開始の準備が完了したとは限りません。
              </p>
            </>
          )}
          <a className="underline" href="/game/">
            インスタンス一覧を開く
          </a>
        </div>
      )}
    </Panel>
  );
}
