import type { ParticipationTarget } from '../../../shared/participation';
import { useApp } from '../../app/context';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import ForeignGame from './ForeignGame';
import ForeignRooms from './ForeignRooms';
import { foreignPlayPath } from './redirect';

export default function ForeignPlay({ mode }: { mode: ParticipationTarget['mode'] }) {
  const { foreignLogin, foreignParticipation, url } = useApp();
  const data = foreignLogin?.data,
    model = foreignParticipation,
    instanceId = url.searchParams.get('instance') ?? '',
    instance = data?.instances.find((instance) => instance.id === instanceId),
    session = model?.session?.mode === mode ? model.session : null;
  if (!data || !model) return null;
  const differentAccount =
    !!session &&
    (session.homeOrigin !== data.account.homeOrigin ||
      session.sourceOrganizationId !== data.account.organizationId ||
      session.sourceActorId !== data.account.sourceActorId);
  if (differentAccount)
    return (
      <p role="alert">
        別のアカウントでの参加が残っています。ログアウトしてから開き直してください。
      </p>
    );
  const target: ParticipationTarget = {
    peerOrigin: data.account.homeOrigin,
    sourceOrganizationId: data.account.organizationId,
    hostInstanceId: instanceId,
    mode,
  };
  return (
    <div className="grid gap-5">
      {model.error && <p role="alert">{model.error}</p>}
      {session && (
        <div hidden={session.instanceId !== instanceId}>
          {mode === 'room' ? (
            <ForeignRooms
              key={session.reservationId}
              session={session}
              entry={{
                account: data.account,
                instanceId: session.instanceId,
                instanceName: session.instanceName,
              }}
              onEnded={model.endSession}
            />
          ) : (
            <ForeignGame session={session} busy={model.busy} cancel={model.cancel} />
          )}
        </div>
      )}
      {(!session || session.instanceId !== instanceId) &&
        (mode === 'room' && instance?.room && url.pathname === foreignPlayPath(mode) ? (
          <ForeignRooms
            key={`entry:${instance.id}`}
            entry={{
              account: data.account,
              instanceId: instance.id,
              instanceName: instance.name,
            }}
            onEnded={model.endSession}
          />
        ) : (
          <Panel title={instance?.name ?? 'インスタンス'}>
            <div className="my-4 grid gap-3">
              <p>
                表示名：{data.account.name} ／ 所属：{data.account.organizationName}
              </p>
              {!instance ? (
                <p>インスタンスを選んでください。</p>
              ) : (
                <>
                  <p>
                    {mode === 'ranked'
                      ? 'レート対象の対戦です。参加者がそろうと開始します。'
                      : mode === 'casual'
                        ? 'レート対象外の対戦です。参加者がそろうと開始します。'
                        : '部屋を選んで参加、または新しい部屋を作成できます。'}
                  </p>
                  <Button
                    tone="primary"
                    disabled={model.busy || !instance[mode]}
                    onClick={() => model.join(target)}
                  >
                    {mode === 'room' ? '部屋を開く' : 'マッチングする'}
                  </Button>
                  {!instance[mode] && (
                    <p>現在、この対戦への外部参加を受け付けていません。</p>
                  )}
                  {session && (
                    <p>
                      新しい参加が成立すると以前の参加から離脱します。開始済みのランクからの離脱はレートが20減ります。
                    </p>
                  )}
                </>
              )}
            </div>
          </Panel>
        ))}
    </div>
  );
}
