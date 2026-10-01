import { useApp } from '../app/context';
import PageHeader from '../components/PageHeader';
import LoginForm from '../features/auth/LoginForm';
import OrganizationGateway from '../features/organization/OrganizationGateway';

export default function MatchPage() {
  const { auth, organization, url } = useApp();
  const selected = organization.data?.instances.find(
    (instance) => instance.id === url.searchParams.get('instance'),
  );
  const view = url.searchParams.get('view');
  const title =
    view === 'delete'
      ? 'インスタンスの完全削除'
      : view === 'organization'
        ? '組織設定・アカウント一覧'
        : view === 'settings'
          ? 'インスタンス設定'
          : view === 'closure'
            ? '運営終了・再開'
            : view === 'history'
              ? '対戦履歴・ランキング'
              : selected
                ? '対戦する'
                : 'インスタンス一覧';

  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-10 sm:px-8 sm:pt-10 sm:pb-16">
      <PageHeader
        title={auth.user ? title : '早押しクイズ'}
        description={selected?.name ?? 'インスタンスを選んで、対戦に参加しましょう。'}
      />
      {!auth.ready ? (
        <p role="status">ログイン状態を確認しています。</p>
      ) : auth.user ? (
        <OrganizationGateway />
      ) : (
        <LoginForm auth={auth} />
      )}
    </main>
  );
}
