import { useEffect } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { useApp } from '../../app/context';
import { ROOMS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import DataTable from '../../components/DataTable';
import Panel from '../../components/Panel';
import GameBoard from '../game/GameBoard';
import { useMutation } from '../moderation/useMutation';
import { playRequest } from './api';
import PlayResults from './PlayResults';
import RoomRules from './RoomRules';
import type { useRoom } from './useRoom';

export default function RoomLobby({ session }: { session: ReturnType<typeof useRoom> }) {
  const { organization, guest, setMatchStatus } = useApp();
  const room = session.room,
    actor = organization.data?.account?.actorId ?? guest?.data?.id;
  const mutation = useMutation(
    API_PATHS.roomMutate,
    async (request) => {
      if (request.action === 'return') session.game.leave();
      await session.refresh();
    },
    (path, body) => playRequest(path, body, session.active?.instanceId),
  );
  const leaving = useMutation(API_PATHS.roomLeave, session.leave, (path, body) =>
    playRequest(path, body, session.active?.instanceId),
  );
  const locked = mutation.busy || mutation.uncertain || leaving.busy || leaving.uncertain;
  useEffect(() => {
    if (!session.active) return;
    const roomId = session.active.id;
    setMatchStatus({
      instanceId: session.active.instanceId,
      roomId: session.active.id,
      retained: true,
      finished: false,
      href: `${ROOMS_PATH}?instance=${session.active.instanceId}&room=${session.active.id}`,
    });
    return () =>
      setMatchStatus((current) => (current?.roomId === roomId ? null : current));
  }, [session.active, setMatchStatus]);
  if (!room) return <p role="status">ロビーを確認しています。{session.error}</p>;
  const member = room.members.find((m) => m.id === actor),
    host = room.hostId === actor;
  const finished = session.game.snapshot?.result;
  const input = { room: room.id, revision: room.revision };
  const invite = `${location.origin}${ROOMS_PATH}?instance=${room.instanceId}&room=${room.id}&invite=${room.invite ?? ''}`;
  return (
    <>
      <Panel title={room.settings.name}>
        <RoomRules settings={room.settings} />
        <p role="status">
          {room.closed ? '部屋は閉じています。' : room.playing ? '対戦中' : 'ロビー'} ／{' '}
          {session.connection === 'open' ? '接続済み' : '接続を確認中'}
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
                {m.id === room.hostId && room.settings.presenter ? '出題専任' : '回答者'}
              </td>
              <td>{m.ready ? '準備完了' : '未完了'}</td>
              <td>{m.connected ? '接続中' : '切断中'}</td>
            </tr>
          ))}
        </DataTable>
        {!room.playing && !room.closed && (
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              disabled={locked || session.connection !== 'open'}
              onClick={() =>
                void mutation.submit({ ...input, action: 'ready', ready: !member?.ready })
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
          </div>
        )}
        {finished && (
          <Button
            className="mt-4"
            disabled={locked}
            onClick={() => void mutation.submit({ ...input, action: 'return' })}
          >
            同じ部屋のロビーへ戻る
          </Button>
        )}
        {host && (
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
        <Button
          className="mt-4"
          disabled={locked || room.playing}
          onClick={() => void leaving.submit({ room: room.id })}
        >
          部屋から退出
        </Button>
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
      {session.game.roomId && (
        <>
          <GameBoard game={session.game} />
          {session.game.error && <p role="alert">{session.game.error}</p>}
          {session.game.connection === 'stopped' && (
            <Button onClick={session.game.reconnect}>対戦に再接続</Button>
          )}
        </>
      )}
      {(!room.playing || finished) && (
        <PlayResults
          instanceId={room.instanceId}
          refreshKey={`${finished?.id ?? ''}:${finished?.storage ?? ''}`}
        />
      )}
    </>
  );
}
