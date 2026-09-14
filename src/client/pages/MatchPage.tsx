import PageHeader from '../components/PageHeader';
import LoginForm from '../features/auth/LoginForm';
import { useAuth } from '../features/auth/useAuth';
import MatchLobby from '../features/matchmaking/MatchLobby';

export default function MatchPage() {
  const auth = useAuth();
  return (
    <main className="mx-auto max-w-4xl px-4 pt-6 pb-10 sm:px-8 sm:pt-10 sm:pb-16">
      <PageHeader
        title="早押しクイズ"
        description="ログインして対戦に参加しましょう。人数とルールは大会の設定を使います。"
      />
      {auth.message && (
        <p role="status" className="my-4 border border-line p-3">
          {auth.message}
        </p>
      )}
      {!auth.ready ? (
        <p role="status">ログイン状態を確認しています。</p>
      ) : auth.user ? (
        <MatchLobby key={auth.user.id} auth={auth} />
      ) : (
        <LoginForm auth={auth} />
      )}
    </main>
  );
}
