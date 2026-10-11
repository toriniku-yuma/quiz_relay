import { useEffect } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { ForeignSession } from '../../../shared/participation';
import { useApp } from '../../app/context';
import Button from '../../components/Button';
import GameBoard from '../game/GameBoard';
import { useGame } from '../game/useGame';
import { foreignPlayPath } from './redirect';

export default function ForeignGame({
  session,
  busy,
  cancel,
}: {
  session: ForeignSession;
  busy: boolean;
  cancel: (forfeit: boolean) => Promise<void>;
}) {
  const { setMatchStatus } = useApp();
  const href = `${foreignPlayPath(session.mode)}?instance=${session.instanceId}`;
  const socketPath = `${API_PATHS.participationSocket}?reservation=${session.reservationId}`;
  const game = useGame(
    'formal',
    `federation:${session.reservationId}`,
    session.instanceId,
    socketPath,
  );
  useEffect(() => {
    game.attach(session.room, session.instanceId);
  }, [session.room, session.instanceId, game.attach]);
  const finished = !!game.snapshot?.result,
    waiting = game.snapshot?.phase === 'WAITING',
    playing = !!game.roomId && !!game.snapshot && !waiting;
  useEffect(() => {
    setMatchStatus({
      instanceId: session.instanceId,
      roomId: game.roomId,
      mode: session.mode,
      playing,
      finished,
      retained: true,
      href,
    });
    return () => {
      setMatchStatus((current) => (current?.roomId === game.roomId ? null : current));
    };
  }, [
    session.instanceId,
    session.mode,
    game.roomId,
    playing,
    finished,
    setMatchStatus,
    href,
  ]);
  return (
    <div className="grid gap-5">
      <p>
        {session.instanceName}で{session.name}として参加しています。
      </p>
      <p role="status">
        {game.connection === 'open'
          ? '接続済み'
          : game.connection === 'stopped'
            ? '接続を終了しました'
            : game.connection === 'closed'
              ? '再接続しています'
              : '接続を確認しています'}
      </p>
      {game.error && <p role="alert">{game.error}</p>}
      {game.connection !== 'open' && (
        <Button onClick={game.reconnect}>接続を再試行</Button>
      )}
      <GameBoard game={game} />
      {finished && (
        <a
          className="font-bold underline"
          href={`${session.homeOrigin}/history/?external=1`}
        >
          所属元の履歴を確認
        </a>
      )}
      <Button
        disabled={busy}
        onClick={() => {
          void cancel(!waiting && !finished);
        }}
      >
        {finished ? '参加を終了' : waiting ? '待機を取り消す' : '試合から離脱'}
      </Button>
      {!!game.roomId && !waiting && !finished && session.mode === 'ranked' && (
        <p className="text-sm">開始済みのランクから離脱すると、レートが20減ります。</p>
      )}
    </div>
  );
}
