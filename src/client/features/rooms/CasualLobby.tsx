import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/context';
import { navigate } from '../../app/navigation';
import { CASUAL_PATH } from '../../app/paths';
import Button from '../../components/Button';
import Modal from '../../components/Modal';
import Panel from '../../components/Panel';
import GameBoard from '../game/GameBoard';
import { useMatchmaking } from '../matchmaking/useMatchmaking';
import ResultLinks from '../results/ResultLinks';
import GuestName from './GuestName';
export default function CasualLobby({
  instanceId,
  targetInstanceId = instanceId,
}: {
  instanceId: string;
  targetInstanceId?: string;
}) {
  const { auth, guest, organization, setMatchStatus, url } = useApp();
  const match = useMatchmaking(
    auth.user?.id ?? guest?.data?.id ?? '',
    instanceId,
    'casual',
    targetInstanceId,
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
  const playing = !!game.snapshot && game.snapshot.phase !== 'WAITING' && !finished;
  useEffect(() => {
    if (!game.roomId) return;
    const roomId = game.roomId;
    setMatchStatus({
      instanceId: game.roomInstanceId,
      roomId: game.roomId,
      retained: !finished,
      finished,
      mode: 'casual',
      playing,
      href: `${CASUAL_PATH}?instance=${game.roomInstanceId}${auth.user ? '' : '&guest=1'}`,
    });
    return () =>
      setMatchStatus((current) => (current?.roomId === roomId ? null : current));
  }, [game.roomInstanceId, game.roomId, finished, playing, setMatchStatus, auth.user]);
  const previous = useRef(url.href);
  const matching = url.pathname === CASUAL_PATH && !url.searchParams.get('view');
  useEffect(() => {
    if (previous.current !== url.href && matching && game.roomId && playing)
      match.offerRestore();
    previous.current = url.href;
  }, [url.href, matching, game.roomId, playing, match.offerRestore]);
  return (
    <>
      {game.roomId && match.viewing && game.roomInstanceId === targetInstanceId ? (
        <>
          <GameBoard game={game} />
          {game.snapshot?.phase === 'WAITING' &&
            match.players &&
            game.snapshot.playersRequired !== match.players && (
              <p className="my-4" role="status">
                この待機は変更前の{game.snapshot.playersRequired}人設定です。現在の
                {match.players}
                人設定で参加するには、待機を取り消して参加し直してください。
              </p>
            )}
          {game.snapshot?.phase === 'WAITING' && (
            <Button className="mt-4" disabled={match.busy} onClick={match.cancel}>
              待機を取り消す
            </Button>
          )}
          {finished && (
            <Button className="mt-4" onClick={game.leave}>
              次のマッチングへ
            </Button>
          )}
          {game.connection === 'stopped' && (
            <Button onClick={game.reconnect}>再接続</Button>
          )}
        </>
      ) : (
        <Panel title="カジュアルマッチ">
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
              {match.uncertain ? '同じ内容で再試行' : 'マッチングする'}
            </Button>
            <Button disabled={match.busy} onClick={match.resume}>
              参加中の試合へ戻る
            </Button>
          </div>
        </Panel>
      )}
      {match.uncertain && (
        <p role="status" className="my-4">
          参加結果が不明です。同じ内容で再試行してください。
        </p>
      )}
      {matching && match.restored && playing && (
        <Modal title="参加中のカジュアルマッチがあります" onClose={match.dismissRestored}>
          <Button
            tone="primary"
            disabled={match.busy}
            onClick={() => {
              navigate(
                `${CASUAL_PATH}?instance=${game.roomInstanceId}${auth.user ? '' : '&guest=1'}`,
              );
              void match.resume();
            }}
          >
            参加中の試合へ戻る
          </Button>
        </Modal>
      )}
      {(match.error || game.error) && (
        <p className="my-3" role="alert">
          {match.error || game.error}
        </p>
      )}
      {game.snapshot?.result && (
        <ResultLinks instanceId={game.roomInstanceId} result={game.snapshot.result} />
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
