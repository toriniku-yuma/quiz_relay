import { useApp } from '../app/context';
import Button from '../components/Button';
import PersonalRestrictions from '../features/moderation/PersonalRestrictions';
import ProfileEditor from '../features/profile/ProfileEditor';

export default function ProfilePage() {
  const { auth, organization } = useApp();
  const account = organization.data?.account;
  return (
    <main className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 tabIndex={-1} className="mb-6 text-3xl font-bold outline-none">
        マイページ
      </h1>
      {!auth.ready || (auth.user && !account && !organization.error) ? (
        <p role="status">プロフィールを読み込んでいます。</p>
      ) : !auth.user ? (
        <p>メニューからログインしてください。</p>
      ) : account ? (
        <ProfileEditor
          key={account.actorId}
          initial={{
            displayName: account.displayName ?? null,
            revision: account.profileRevision ?? 0,
          }}
        />
      ) : (
        <p>プロフィールを利用するには組織の初期設定が必要です。</p>
      )}
      {organization.error && <p role="alert">{organization.error}</p>}
      {auth.user && account && <PersonalRestrictions key={account.actorId} />}
      {organization.loadFailed && (
        <Button disabled={organization.busy} onClick={organization.refresh}>
          再試行
        </Button>
      )}
    </main>
  );
}
