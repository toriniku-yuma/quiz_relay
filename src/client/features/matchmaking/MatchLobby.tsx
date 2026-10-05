import { useEffect, useRef, useState } from 'react';
import { type MatchStatus, useApp } from '../../app/context';
import { navigate } from '../../app/navigation';
import { GAME_PATH, PROFILE_PATH } from '../../app/paths';
import Button from '../../components/Button';
import Modal from '../../components/Modal';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import type { Auth } from '../auth/useAuth';
import GameBoard from '../game/GameBoard';
import ResultLinks from '../results/ResultLinks';
import { useMatchmaking } from './useMatchmaking';

export default function MatchLobby({
  auth,
  instanceId = '',
  targetInstanceId = instanceId,
  onStatus,
}: {
  auth: Auth;
  instanceId?: string;
  targetInstanceId?: string;
  onStatus?: (status: MatchStatus) => void;
}) {
  const { organization, url } = useApp();
  const match = useMatchmaking(
    auth.user?.id ?? '',
    instanceId,
    'ranked',
    targetInstanceId,
    `${url.pathname}${url.search}`,
  );
  const registeredName = organization.data?.account?.displayName;
  const organized = organization.data?.enabled === true;
  const [name, setName] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const game = match.game;
  const finished =
    game.snapshot?.phase === 'FINISHED' || game.snapshot?.phase === 'INVALID';
  const roomId = game.roomId ?? null;
  const playing = !!game.snapshot && game.snapshot.phase !== 'WAITING' && !finished;
  const retained = match.busy || (!!roomId && !finished);
  const confirmedResultId =
    game.snapshot?.result?.storage === 'confirmed' ? game.snapshot.result.id : undefined;
  useEffect(() => {
    onStatus?.({
      instanceId: game.roomInstanceId,
      roomId,
      retained,
      finished,
      mode: 'ranked',
      playing,
    });
  }, [onStatus, game.roomInstanceId, roomId, retained, finished, playing]);
  useEffect(() => {
    if (confirmedResultId)
      window.dispatchEvent(
        new CustomEvent('results:refresh', {
          detail: { instanceId: game.roomInstanceId },
        }),
      );
  }, [confirmedResultId, game.roomInstanceId]);
  const previous = useRef(url.href);
  const matching = url.pathname === GAME_PATH && !url.searchParams.get('view');
  useEffect(() => {
    if (previous.current !== url.href && matching && game.roomId && playing)
      match.offerRestore();
    previous.current = url.href;
  }, [url.href, matching, game.roomId, playing, match.offerRestore]);

  return (
    <>
      {match.activeInstance && (
        <a
          className="my-3 block underline"
          href={`/game/?instance=${encodeURIComponent(match.activeInstance)}`}
        >
          参加中のインスタンスへ戻る
        </a>
      )}
      {(match.error || game.error || logoutError) && (
        <p role="alert" className="my-4 border border-accent p-3">
          {match.error || game.error || logoutError}
        </p>
      )}
      {game.roomId && match.viewing && game.roomInstanceId === targetInstanceId ? (
        <>
          <p role="status" className="my-3">
            {game.connection === 'open' ? '接続済み' : '接続を確認しています。'}
          </p>
          {game.snapshot && <GameBoard game={game} />}
          {game.snapshot?.phase === 'WAITING' &&
            match.players &&
            game.snapshot.playersRequired !== match.players && (
              <p className="my-4" role="status">
                この待機は変更前の{game.snapshot.playersRequired}人設定です。現在の
                {match.players}
                人設定で参加するには、待機を取り消して参加し直してください。
              </p>
            )}
          {(game.connection === 'stopped' || game.connection === 'idle') && (
            <Button onClick={game.reconnect}>再接続</Button>
          )}
          {!game.snapshot || game.snapshot.phase === 'WAITING' ? (
            <Button className="mt-5 mr-3" onClick={match.cancel} disabled={match.busy}>
              待機を取り消す
            </Button>
          ) : null}
          {finished && (
            <Button className="mt-5" onClick={game.leave}>
              次のマッチングへ
            </Button>
          )}
        </>
      ) : (
        <Panel title="ランクマッチング">
          <p className="mt-3">
            同じインスタンスの参加者を探します。
            {match.players ? `${match.players}人` : '設定人数'}
            の接続がそろうと、自動で出題します。開始前は取り消せます。
          </p>
          {match.rules && (
            <p className="mt-3">
              {match.rules.correctAnswersToWin}問先取・{match.rules.mistakesToDisqualify}
              回お手つきで失格。
            </p>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void match.join(organized ? (registeredName ?? '') : name);
            }}
          >
            {organized ? (
              <p className="my-4">
                表示名：{registeredName ?? '未登録'}{' '}
                <a className="underline" href={PROFILE_PATH}>
                  マイページで変更
                </a>
              </p>
            ) : (
              <TextField
                id="match-name"
                label="表示名"
                placeholder="例：クイズ太郎"
                autoComplete="nickname"
                maxLength={24}
                required
                value={name}
                disabled={match.busy || match.uncertain}
                onChange={(event) => setName(event.target.value)}
              />
            )}
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                tone="primary"
                disabled={match.busy || (organized && !registeredName)}
              >
                {match.uncertain ? '同じ内容で再試行' : 'マッチングする'}
              </Button>
              <Button onClick={match.resume} disabled={match.busy}>
                参加中の試合へ戻る
              </Button>
            </div>
          </form>
        </Panel>
      )}
      {match.uncertain && (
        <p role="status" className="my-4">
          参加結果が不明です。入力を保持したまま、同じ内容で再試行してください。
        </p>
      )}
      {matching && match.restored && playing && (
        <Modal title="参加中のランクマッチがあります" onClose={match.dismissRestored}>
          <Button
            tone="primary"
            disabled={match.busy}
            onClick={() => {
              navigate(`${GAME_PATH}?instance=${game.roomInstanceId}`);
              void match.resume();
            }}
          >
            参加中の試合へ戻る
          </Button>
        </Modal>
      )}
      {game.snapshot?.result && (
        <ResultLinks instanceId={game.roomInstanceId} result={game.snapshot.result} />
      )}
      <Button
        className="mt-5"
        disabled={match.busy || auth.busy}
        onClick={async () => {
          setLogoutError('');
          try {
            await auth.logout();
          } catch {
            setLogoutError(
              '退出を確認できませんでした。通信を確認して再度お試しください。',
            );
          }
        }}
      >
        ログアウト
      </Button>
    </>
  );
}
