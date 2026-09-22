import { useEffect, useState } from 'react';
import type { MatchStatus } from '../../app/context';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import type { Auth } from '../auth/useAuth';
import GameBoard from '../game/GameBoard';
import ResultsPanel from '../results/ResultsPanel';
import { useMatchmaking } from './useMatchmaking';

export default function MatchLobby({
  auth,
  instanceId = '',
  onStatus,
}: {
  auth: Auth;
  instanceId?: string;
  onStatus?: (status: MatchStatus) => void;
}) {
  const match = useMatchmaking(auth.user?.id ?? '', instanceId);
  const [name, setName] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const game = match.game;
  const finished =
    game.snapshot?.phase === 'FINISHED' || game.snapshot?.phase === 'INVALID';
  const roomId = game.roomId ?? null;
  const retained = match.busy || (!!roomId && !finished);
  useEffect(() => {
    onStatus?.({ instanceId, roomId, retained, finished });
  }, [onStatus, instanceId, roomId, retained, finished]);

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
      {game.roomId ? (
        <>
          <p role="status" className="my-3">
            {game.connection === 'open' ? '接続済み' : '接続を確認しています。'}
          </p>
          {game.snapshot && <GameBoard game={game} />}
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
              void match.join(name);
            }}
          >
            <TextField
              id="match-name"
              label="表示名"
              placeholder="例：クイズ太郎"
              autoComplete="nickname"
              maxLength={24}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" tone="primary" disabled={match.busy}>
                マッチングする
              </Button>
              <Button onClick={match.resume} disabled={match.busy}>
                参加中の試合へ戻る
              </Button>
            </div>
          </form>
        </Panel>
      )}
      {(!game.roomId || finished) && (
        <ResultsPanel
          instanceId={instanceId}
          refreshKey={`${auth.user?.id}:${game.snapshot?.result?.id ?? ''}:${game.snapshot?.result?.storage ?? ''}`}
        />
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
