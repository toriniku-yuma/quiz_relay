import { useApp } from '../app/context';
import { navigate } from '../app/navigation';
import { GAME_PATH } from '../app/paths';
import Button from '../components/Button';
import PageHeader from '../components/PageHeader';
import LoginForm from '../features/auth/LoginForm';
import OrganizationGateway from '../features/organization/OrganizationGateway';
import MatchingRanking from '../features/results/MatchingRanking';
import GuestInstances from '../features/rooms/GuestInstances';

export default function MatchPage() {
  const { auth, organization, url } = useApp();
  const selected = organization.data?.instances.find(
    (instance) => instance.id === url.searchParams.get('instance'),
  );
  const view = url.searchParams.get('view');
  const matching =
    url.pathname.replace(/\/$/, '') === GAME_PATH.replace(/\/$/, '') && !view;
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
              ? '対戦履歴'
              : selected
                ? '対戦する'
                : 'インスタンス一覧';

  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-10 sm:px-8 sm:pt-10 sm:pb-16">
      <PageHeader
        title={auth.user ? title : '早押しクイズ'}
        description={selected?.name ?? 'インスタンスを選んで、対戦に参加しましょう。'}
      />
      {auth.user && matching && (selected || organization.data?.enabled === false) && (
        <MatchingRanking instanceId={selected?.id ?? ''} />
      )}
      {!auth.ready ? (
        <p role="status">ログイン状態を確認しています。</p>
      ) : !auth.user &&
        (url.searchParams.get('guest') === '1' ||
          (url.searchParams.has('instance') && !view)) ? (
        <GuestInstances instanceId={url.searchParams.get('instance') ?? ''} />
      ) : auth.user ? (
        <OrganizationGateway />
      ) : (
        <>
          <LoginForm auth={auth} />
          <Button
            tone="primary"
            className="mt-6 w-full"
            onClick={() => navigate('/game/?guest=1')}
          >
            ゲストで遊ぶ
          </Button>
        </>
      )}
    </main>
  );
}
