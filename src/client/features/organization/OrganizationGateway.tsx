import { useEffect, useState } from 'react';
import { canAccessInstance } from '../../../shared/organization';
import { useApp } from '../../app/context';
import { gameHref } from '../../app/navigation';
import { GAME_PATH } from '../../app/paths';
import MatchLobby from '../matchmaking/MatchLobby';
import ResultsPanel from '../results/ResultsPanel';
import OrganizationPanel from './OrganizationPanel';

export default function OrganizationGateway() {
  const { auth, organization, url, matchStatus, setMatchStatus } = useApp();
  const instanceId = url.searchParams.get('instance') ?? '';
  const view = url.searchParams.get('view') ?? '';
  const selected = organization.data?.instances.find(
    (instance) => instance.id === instanceId,
  );
  const legacy = organization.data?.enabled === false;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const matchingPage =
    url.pathname.replace(/\/$/, '') === GAME_PATH.replace(/\/$/, '') && !view;
  const available =
    legacy || canAccessInstance(selected, organization.data?.account?.administrator);
  const canSwitch =
    sessionId === null ||
    (matchStatus?.instanceId === sessionId && !matchStatus.retained);

  useEffect(() => {
    if (matchingPage && available && canSwitch) setSessionId(instanceId);
  }, [matchingPage, available, canSwitch, instanceId]);

  return (
    <>
      {selected?.state === 'preparing' && available && !view && (
        <p role="status" className="my-3">
          準備中：このインスタンスの運営者のみ参加できます。通常の戦績・レートに反映されます。
        </p>
      )}
      {sessionId !== null && (
        <div hidden={!matchingPage || !available || sessionId !== instanceId}>
          <MatchLobby
            key={sessionId}
            auth={auth}
            instanceId={sessionId}
            onStatus={setMatchStatus}
          />
        </div>
      )}
      {!view && available && sessionId !== instanceId && (
        <p role="status" className="my-4 border border-line p-4">
          {matchStatus?.roomId
            ? '別のインスタンスで対戦中です。参加するには、先に現在の対戦を終えるか待機を取り消してください。'
            : '参加状態を確認しています。'}
          {matchStatus?.roomId && (
            <a className="mt-2 block underline" href={gameHref(matchStatus.instanceId)}>
              対戦に戻る
            </a>
          )}
        </p>
      )}
      {view === 'history' && available && (
        <ResultsPanel
          key={instanceId}
          instanceId={instanceId}
          refreshKey={auth.user?.id ?? ''}
        />
      )}
      {view === 'settings' && selected && organization.data?.account?.administrator ? (
        <OrganizationPanel
          key={selected.id}
          organization={organization}
          management
          instanceId={selected.id}
        />
      ) : view === 'organization' && organization.data?.account?.administrator ? (
        <OrganizationPanel organization={organization} management />
      ) : !available ? (
        <>
          {instanceId && organization.data && !selected && (
            <p role="alert" className="my-3">
              指定されたインスタンスは利用できません。
            </p>
          )}
          {selected?.state === 'preparing' && (
            <p className="my-3">このインスタンスは準備中です。</p>
          )}
          <OrganizationPanel organization={organization} />
        </>
      ) : (
        view &&
        view !== 'history' && (
          <p role="alert" className="my-3">
            この画面は利用できません。メニューから選び直してください。
          </p>
        )
      )}
    </>
  );
}
