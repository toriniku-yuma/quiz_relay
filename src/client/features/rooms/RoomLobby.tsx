import { useEffect } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { useApp } from '../../app/context';
import { navigate } from '../../app/navigation';
import { ROOMS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import DataTable from '../../components/DataTable';
import Panel from '../../components/Panel';
import GameBoard from '../game/GameBoard';
import { useMutation } from '../moderation/useMutation';
import ResultLinks from '../results/ResultLinks';
import { playRequest } from './api';
import RoomRules from './RoomRules';
import type { useRoom } from './useRoom';

export default function RoomLobby({
  session,
  gamePage = false,
}: {
  session: ReturnType<typeof useRoom>;
  gamePage?: boolean;
}) {
  const { auth, organization, guest, setMatchStatus } = useApp();
  const room = session.room,
    actor = organization.data?.account?.actorId ?? guest?.data?.id;
  const mutation = useMutation(
    API_PATHS.roomMutate,
    async (request) => {
      if (!session.isCurrent(request.room)) return;
      await session.refresh();
      if (!session.isCurrent(request.room)) return;
      if (request.action === 'return') {
        session.game.leave();
        navigate(
          `${ROOMS_PATH}?instance=${session.active?.instanceId}&room=${session.active?.id}${auth.user ? '' : '&guest=1'}`,
          true,
        );
      }
    },
    (path, body) =>
      playRequest(path, body, String((body as Record<string, unknown>).instanceId)),
  );
  const leaving = session.exit;
  const locked = mutation.busy || mutation.uncertain || leaving.busy || leaving.uncertain;
  useEffect(() => {
    if (!session.active) return;
    const roomId = session.active.id;
    setMatchStatus({
      instanceId: session.active.instanceId,
      roomId: session.active.id,
      retained: true,
      finished: false,
      mode: 'room',
      playing:
        !!session.room?.matchRoom &&
        !session.room.waiting &&
        !session.game.snapshot?.result,
      href: `${ROOMS_PATH}?instance=${session.active.instanceId}&room=${session.active.id}${session.room?.matchRoom && !session.room.waiting ? '&view=game' : ''}${auth.user ? '' : '&guest=1'}`,
    });
    return () =>
      setMatchStatus((current) => (current?.roomId === roomId ? null : current));
  }, [
    session.active,
    session.room?.matchRoom,
    session.room?.waiting,
    session.game.snapshot?.result,
    setMatchStatus,
    auth.user,
  ]);
  if (!room) return <p role="status">ロビーを確認しています。{session.error}</p>;
  const member = room.members.find((m) => m.id === actor),
    host = room.hostId === actor;
  const finished = session.game.snapshot?.result;
  const input = { room: room.id, instanceId: room.instanceId, revision: room.revision };
  const invite = `${location.origin}${ROOMS_PATH}?instance=${room.instanceId}&room=${room.id}&invite=${room.invite ?? ''}`;
  return (
    <div className="grid gap-5">
      <Panel title={room.settings.name}>
        {!gamePage && (
          <>
            <RoomRules settings={room.settings} />
            <p role="status">
              {room.closed ? '部屋は閉じています。' : room.playing ? '対戦中' : 'ロビー'}{' '}
              ／ {session.connection === 'open' ? '接続済み' : '接続を確認中'}
            </p>
            {room.waiting && (
              <p>途中入室のため、現在の試合が終わるまでロビーでお待ちください。</p>
            )}
            <DataTable label="部屋の参加者" columns={['名前', '役割', '準備', '接続']}>
              {room.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.name}
                    {m.guest ? '（ゲスト）' : ''}
                    {m.id === room.hostId ? '（部屋主）' : ''}
                  </td>
                  <td>
                    {m.id === room.hostId && room.settings.presenter
                      ? '出題専任'
                      : '回答者'}
                  </td>
                  <td>{m.ready ? '準備完了' : '未完了'}</td>
                  <td>{m.connected ? '接続中' : '切断中'}</td>
                </tr>
              ))}
            </DataTable>
          </>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!gamePage && !room.playing && !room.closed && (
            <>
              <Button
                tone="primary"
                disabled={locked || session.connection !== 'open'}
                onClick={() =>
                  void mutation.submit({
                    ...input,
                    action: 'ready',
                    ready: !member?.ready,
                  })
                }
              >
                {member?.ready ? '準備完了を取り消す' : '準備完了'}
              </Button>
              {host && (
                <>
                  <Button
                    tone="primary"
                    disabled={locked || session.connection !== 'open'}
                    onClick={() => void mutation.submit({ ...input, action: 'start' })}
                  >
                    部屋主が開始
                  </Button>
                  <a
                    className="p-3 underline"
                    href={`${ROOMS_PATH}?instance=${room.instanceId}&room=${room.id}&view=edit`}
                  >
                    設定を変更
                  </a>
                </>
              )}
            </>
          )}
          {finished && (
            <Button
              disabled={locked}
              onClick={() => void mutation.submit({ ...input, action: 'return' })}
            >
              同じ部屋のロビーへ戻る
            </Button>
          )}
          <Button
            disabled={locked || (room.playing && !room.waiting && !finished)}
            onClick={() =>
              void leaving.submit({ room: room.id, instanceId: room.instanceId })
            }
          >
            部屋から退出
          </Button>
        </div>
        {!gamePage && host && (
          <details className="mt-4">
            <summary>招待と部屋の管理</summary>
            <div className="mt-3 grid gap-3">
              <a className="break-all underline" href={invite}>
                招待URL
              </a>
              <Button
                disabled={locked || room.closed}
                onClick={() => void mutation.submit({ ...input, action: 'invite' })}
              >
                招待URLを再発行
              </Button>
              <p>再発行すると、古いURLでの新しい入室ができなくなります。</p>
              <Button
                disabled={locked || room.closed}
                onClick={() => void mutation.submit({ ...input, action: 'close' })}
              >
                部屋を閉じる
              </Button>
            </div>
          </details>
        )}
        {(session.error || mutation.error || leaving.error) && (
          <p className="mt-3" role="alert">
            {session.error || mutation.error || leaving.error}
          </p>
        )}
        {mutation.uncertain && (
          <Button disabled={mutation.busy} onClick={() => void mutation.submit({})}>
            同じ操作で再試行
          </Button>
        )}
        {leaving.uncertain && (
          <Button disabled={leaving.busy} onClick={() => void leaving.submit({})}>
            退出を再試行
          </Button>
        )}
      </Panel>
      {gamePage && session.game.roomId && (
        <>
          <GameBoard game={session.game} />
          {session.game.error && <p role="alert">{session.game.error}</p>}
          {session.game.connection === 'stopped' && (
            <Button onClick={session.game.reconnect}>対戦に再接続</Button>
          )}
        </>
      )}
      {finished && <ResultLinks instanceId={room.instanceId} result={finished} />}
    </div>
  );
}
