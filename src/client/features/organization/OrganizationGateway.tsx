import { useCallback, useEffect, useState } from 'react';
import { canAccessInstance } from '../../../shared/organization';
import type { MatchStatus } from '../../app/context';
import { useApp } from '../../app/context';
import { GAME_PATH } from '../../app/paths';
import MatchLobby from '../matchmaking/MatchLobby';
import InstanceClosure from './InstanceClosure';
import InstanceDeletion from './InstanceDeletion';
import OrganizationPanel from './OrganizationPanel';

export default function OrganizationGateway() {
  const { auth, organization, url, setMatchStatus } = useApp();
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
  const canResume = !!organization.data?.account && /^[0-9a-f-]{36}$/.test(instanceId);
  useEffect(() => {
    if (matchingPage && (available || canResume) && sessionId === null)
      setSessionId(instanceId);
  }, [matchingPage, available, canResume, sessionId, instanceId]);
  const onStatus = useCallback(
    (status: MatchStatus) =>
      setMatchStatus((current) =>
        status.roomId ? status : current?.mode === 'ranked' ? null : current,
      ),
    [setMatchStatus],
  );

  return (
    <>
      {selected?.state === 'preparing' && available && !view && (
        <p role="status" className="my-3">
          準備中：このインスタンスの運営者のみ参加できます。通常の戦績・レートに反映されます。
          {selected.pauseReason && <span> 理由：{selected.pauseReason}</span>}
        </p>
      )}
      {selected?.rankedPauseReason && !view && (
        <p role="status" className="my-3">
          ランク停止中：{selected.rankedPauseReason}
          。このインスタンスの運営者は通常参加できます。
        </p>
      )}
      {sessionId !== null && (
        <div hidden={!matchingPage || !available}>
          <MatchLobby
            key={sessionId}
            auth={auth}
            instanceId={sessionId}
            targetInstanceId={instanceId}
            onStatus={onStatus}
          />
        </div>
      )}
      {!view && available && sessionId === null && (
        <p role="status" className="my-4 border border-line p-4">
          参加状態を確認しています。
        </p>
      )}
      {view === 'delete' && selected ? (
        <InstanceDeletion
          key={selected.id}
          instance={selected}
          organization={organization}
        />
      ) : view === 'closure' && selected ? (
        <InstanceClosure
          key={selected.id}
          instance={selected}
          organization={organization}
        />
      ) : view === 'settings' && selected && organization.data?.account?.administrator ? (
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
