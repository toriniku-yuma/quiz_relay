import { participationTarget } from '../../shared/participation';
import { useApp } from '../app/context';
import { PROFILE_PATH } from '../app/paths';
import Button from '../components/Button';
import PageHeader from '../components/PageHeader';
import LoginForm from '../features/auth/LoginForm';
import { foreignPlayPath } from '../features/federation/redirect';
import { useParticipationAuthorization } from '../features/federation/useParticipationAuthorization';

export default function ParticipationAuthorizationPage() {
  const { auth, organization, url } = useApp(),
    target = participationTarget(url, true),
    state = url.searchParams.get('state') ?? '';
  const sourceValid =
    !!target && target.sourceOrganizationId === organization.data?.organization?.id;
  const peer = organization.data?.account?.displayName;
  // participationTarget accepts only the login and participation flows.
  const flow = url.searchParams.get('flow') === 'login' ? 'login' : 'participation';
  const model = useParticipationAuthorization(
    target,
    state,
    url.searchParams.get('operation') ?? '',
    {
      flow,
      ready: !!auth.user && !!peer && sourceValid,
      actor: auth.user?.id ?? '',
    },
  );
  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-8">
      <PageHeader
        title={flow === 'login' ? '外部ログインを確認しています' : '外部対戦への参加確認'}
        description={
          flow === 'login'
            ? '所属元のログインを確認し、開催先へ戻ります。対戦への参加は開催先で行います。'
            : '所属元のアカウントで、開催先の対戦へ参加します。'
        }
      />
      {!target ? (
        <p role="alert">参加先を確認できません。開催先から開き直してください。</p>
      ) : !auth.ready ? (
        <p role="status">ログインを確認しています。</p>
      ) : !auth.user ? (
        <LoginForm auth={auth} />
      ) : !organization.data ? (
        <p role="status">所属組織を確認しています。</p>
      ) : !peer ? (
        <p>
          先に
          <a className="underline" href={PROFILE_PATH} target="_blank" rel="noopener">
            マイページ
          </a>
          で表示名を登録し、この画面を開き直してください。
        </p>
      ) : (
        <div className="grid gap-4">
          <p>表示名：{peer}</p>
          <p>所属組織：{organization.data.organization?.name}</p>
          <p className="break-words">開催先：{target.peerOrigin}</p>
          <p>
            対戦種別：
            {target.mode === 'ranked'
              ? 'ランク'
              : target.mode === 'room'
                ? '部屋'
                : 'カジュアル'}
          </p>
          {flow !== 'login' && (
            <p>
              新しい参加が成立すると、以前の参加先から離脱します。開始済みのランクからの離脱はレートが20減ります。
            </p>
          )}
          {!sourceValid && (
            <p role="alert">指定された所属組織とログイン中の組織が一致しません。</p>
          )}
          {model.error && <p role="alert">{model.error}</p>}
          {model.expired ? (
            <a
              className="font-bold underline"
              href={`${target.peerOrigin}${foreignPlayPath(target.mode)}?instance=${target.hostInstanceId}`}
            >
              開催先に戻る
            </a>
          ) : !model.error ? (
            <p role="status">ログインを確認して開催先へ戻っています。</p>
          ) : (
            <Button
              tone="primary"
              disabled={model.busy || !sourceValid}
              onClick={model.authorize}
            >
              {model.busy ? '確認しています' : '再試行'}
            </Button>
          )}
        </div>
      )}
    </main>
  );
}
