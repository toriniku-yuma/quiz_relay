import { useEffect, useState } from 'react';
import { useApp } from '../app/context';
import PageHeader from '../components/PageHeader';
import LoginForm from '../features/auth/LoginForm';
import ForeignPlay from '../features/federation/ForeignPlay';
import CasualLobby from '../features/rooms/CasualLobby';
export default function CasualPage() {
  const { auth, url, foreignLogin } = useApp();
  const instanceId = url.searchParams.get('instance') ?? '';
  const [active, setActive] = useState('');
  useEffect(() => {
    if (url.pathname === '/casual/' && instanceId && !active) setActive(instanceId);
  }, [url.pathname, instanceId, active]);
  return (
    <main className="mx-auto max-w-4xl p-4 md:p-8">
      <PageHeader title="カジュアルマッチ" description="非レートの自動マッチングです。" />
      {!auth.ready ||
      (!auth.user && foreignLogin && (!foreignLogin.checked || foreignLogin.busy)) ? (
        <p role="status">ログイン状態を確認しています。</p>
      ) : !auth.user && foreignLogin?.data ? (
        <ForeignPlay mode="casual" />
      ) : auth.user || instanceId || url.searchParams.get('guest') === '1' ? (
        active ? (
          <div>
            <CasualLobby
              key={`${active}:${auth.user?.id ?? 'guest'}`}
              instanceId={active}
              targetInstanceId={instanceId}
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
