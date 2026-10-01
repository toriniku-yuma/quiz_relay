import { useEffect, useState } from 'react';
import { useApp } from '../../app/context';
import { CASUAL_PATH } from '../../app/paths';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import GameBoard from '../game/GameBoard';
import { useMatchmaking } from '../matchmaking/useMatchmaking';
import GuestName from './GuestName';
import PlayResults from './PlayResults';
export default function CasualLobby({ instanceId }: { instanceId: string }) {
  const { auth, guest, organization, setMatchStatus } = useApp();
  const match = useMatchmaking(
    auth.user?.id ?? guest?.data?.id ?? '',
    instanceId,
    'casual',
  );
  const [namePrompt, setNamePrompt] = useState(false);
  const [joinAfterName, setJoinAfterName] = useState(false);
  useEffect(() => {
    if (joinAfterName && guest?.data?.id) {
      setJoinAfterName(false);
      void match.join('');
    }
  }, [joinAfterName, guest?.data?.id, match.join]);
  const game = match.game,
    finished = !!game.snapshot?.result;
  useEffect(() => {
    if (!game.roomId) return;
    const roomId = game.roomId;
    setMatchStatus({
      instanceId,
      roomId: game.roomId,
      retained: !finished,
      finished,
      href: `${CASUAL_PATH}?instance=${instanceId}${auth.user ? '' : '&guest=1'}`,
    });
    return () =>
      setMatchStatus((current) => (current?.roomId === roomId ? null : current));
  }, [instanceId, game.roomId, finished, setMatchStatus, auth.user]);
  return (
    <>
      {game.roomId ? (
        <>
          <GameBoard game={game} />
          {game.snapshot?.phase === 'WAITING' && (
            <Button disabled={match.busy} onClick={match.cancel}>
              待機を取り消す
            </Button>
          )}
          {finished && <Button onClick={game.leave}>次のマッチングへ</Button>}
          {game.connection === 'stopped' && (
            <Button onClick={game.reconnect}>再接続</Button>
          )}
        </>
      ) : (
        <Panel title="カジュアル自動マッチング">
          <p className="my-3">
            同じインスタンスで{match.players ?? '設定人数'}
            人の接続がそろうと自動で開始します。7問先取・3回お手つきで失格。レート対象外です。
          </p>
          <p className="my-3">
            表示名：
            {organization.data?.account?.displayName ??
              guest?.data?.name ??
              '初めての参加時に登録'}
          </p>
          <div className="flex gap-3">
            <Button
              tone="primary"
              disabled={match.busy}
              onClick={() => {
                if (!auth.user && !guest?.data?.name) setNamePrompt(true);
                else void match.join('');
              }}
            >
              マッチングする
            </Button>
            <Button disabled={match.busy} onClick={match.resume}>
              参加中の試合へ戻る
            </Button>
          </div>
        </Panel>
      )}
      {(match.error || game.error) && (
        <p className="my-3" role="alert">
          {match.error || game.error}
        </p>
      )}
      {(!game.roomId || finished) && (auth.user || guest?.data?.name) && (
        <PlayResults
          instanceId={instanceId}
          refreshKey={`${game.snapshot?.result?.id}:${game.snapshot?.result?.storage}`}
        />
      )}
      {namePrompt && guest && (
        <GuestName
          onClose={() => setNamePrompt(false)}
          onSaved={async () => {
            await guest.refresh();
            setNamePrompt(false);
            setJoinAfterName(true);
          }}
        />
      )}
    </>
  );
}
