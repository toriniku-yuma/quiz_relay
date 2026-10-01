import { useEffect, useState } from 'react';
import { useApp } from '../app/context';
import PageHeader from '../components/PageHeader';
import LoginForm from '../features/auth/LoginForm';
import CasualLobby from '../features/rooms/CasualLobby';
export default function CasualPage() {
  const { auth, url, matchStatus } = useApp();
  const instanceId = url.searchParams.get('instance') ?? '';
  const [active, setActive] = useState('');
  useEffect(() => {
    if (
      url.pathname === '/casual/' &&
      instanceId &&
      (!active || matchStatus?.retained === false)
    )
      setActive(instanceId);
  }, [url.pathname, instanceId, active, matchStatus?.retained]);
  return (
    <main className="mx-auto max-w-4xl p-4 md:p-8">
      <PageHeader title="カジュアル" description="非レートの自動マッチングです。" />
      {!auth.ready ? (
        <p role="status">ログイン状態を確認しています。</p>
      ) : auth.user || url.searchParams.get('guest') === '1' ? (
        active ? (
          <div hidden={active !== instanceId}>
            <CasualLobby
              key={`${active}:${auth.user?.id ?? 'guest'}`}
              instanceId={active}
            />
          </div>
        ) : (
          <p>インスタンスを選んでください。</p>
        )
      ) : (
        <LoginForm auth={auth} />
      )}
    </main>
  );
}
