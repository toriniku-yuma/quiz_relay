import { useApp } from '../app/context';
import Button from '../components/Button';
import PersonalRestrictions from '../features/moderation/PersonalRestrictions';
import ProfileEditor from '../features/profile/ProfileEditor';
import Withdrawal from '../features/profile/Withdrawal';

export default function ProfilePage() {
  const { auth, organization, url } = useApp();
  const account = organization.data?.account;
  if (url.searchParams.get('view') === 'withdrawal')
    return (
      <main className="mx-auto max-w-3xl p-4 md:p-8">
        <h1 tabIndex={-1} className="mb-6 text-3xl font-bold outline-none">
          退会手続き
        </h1>
        {auth.ready && <Withdrawal key={auth.user?.id ?? 'signed-out'} />}
      </main>
    );
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
          key={`profile:${account.actorId}`}
          initial={{
            displayName: account.displayName ?? null,
            revision: account.profileRevision ?? 0,
          }}
        />
      ) : (
        <p>プロフィールを利用するには組織の初期設定が必要です。</p>
      )}
      {organization.error && <p role="alert">{organization.error}</p>}
      {auth.user && account && (
        <PersonalRestrictions key={`restrictions:${account.actorId}`} />
      )}
      {auth.user &&
        account &&
        organization.data?.instances.some(
          (instance) => instance.state === 'archived' && instance.hasOwnQuestions,
        ) && (
          <section className="my-6">
            <h2 className="mb-3 text-xl font-bold">アーカイブ済みの投稿先</h2>
            <p>自分の投稿問題をエクスポートできます。</p>
            <ul className="mt-3 grid gap-2">
              {organization.data.instances
                .filter(
                  (instance) => instance.state === 'archived' && instance.hasOwnQuestions,
                )
                .map((instance) => (
                  <li key={instance.id}>
                    <a
                      className="underline"
                      href={`/game/?view=closure&instance=${instance.id}`}
                    >
                      {instance.name}
                    </a>
                  </li>
                ))}
            </ul>
          </section>
        )}
      {organization.loadFailed && (
        <Button disabled={organization.busy} onClick={organization.refresh}>
          再試行
        </Button>
      )}
      {auth.user && account && (
        <a href="/account/?view=withdrawal" className="mt-8 block underline">
          退会手続き
        </a>
      )}
    </main>
  );
}
