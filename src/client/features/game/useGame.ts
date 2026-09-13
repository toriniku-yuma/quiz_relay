import { useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { Command, GameMessage, Panel, Snapshot } from '../../../shared/game';
import { type ConnectionStatus, connectGameSocket } from './connection';

import { applyGameUpdate, readGameSession, saveGameSession } from './recovery';

const messages: Record<string, string> = {
  LOCAL_GAME_DISABLED: 'ローカル開発環境でのみ利用できます。',
  ORIGIN_REJECTED: '接続元が許可されていません。',
  INVALID_ROOM: 'ルーム番号は1〜16で指定してください。',
  INVALID_SETUP: '名前・人数・問題番号を確認してください。',
  SETUP_MISMATCH:
    'このルームの人数・問題番号・回答表示設定が違います。最初の参加者と同じ値を指定してください。',
  ROOM_CLOSED:
    '参加枠が埋まっているか、出題が始まっています。別のルームを選んでください。',
  RECONNECT_WAIT: '切断した参加者の復帰を待っています。',
  BUZZ_REJECTED: '今回は早押しを受け付けられませんでした。',
  PANEL_REJECTED: '解答権またはパネルの期限が変わりました。',
  CONNECTION_LIMIT:
    '同じ参加者の接続は3タブまでです。他のタブを閉じてから参加してください。',
  COMMAND_LIMIT: 'この試合であなたが送信できる入力の上限に達しました。',
  STALE_COMMAND: '出題が変わったため入力を受け付けませんでした。',
};

export function useGame() {
  const [saved] = useState(readGameSession);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(saved?.snapshot ?? null);
  const currentSnapshot = useRef<Snapshot | null>(saved?.snapshot ?? null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [actorId, setActorId] = useState('');
  const [connection, setConnection] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [room, setRoom] = useState<{ id: string } | null>(saved?.room ?? null);
  const socket = useRef<WebSocket | null>(null);
  const pendingCommand = useRef<Command | null>(null);
  const offset = useRef(0);

  useEffect(() => {
    if (!room) return;

    const url = new URL(API_PATHS.gameSocket, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', room.id);

    const disconnect = connectGameSocket(url, {
      status: setConnection,
      sync: () =>
        JSON.stringify({
          type: 'sync',
          lastSeq: currentSnapshot.current?.roomSeq ?? null,
          matchId: currentSnapshot.current?.matchId ?? null,
        }),
      error: setError,
      opened: (ws) => {
        socket.current = ws;
        if (pendingCommand.current) ws.send(JSON.stringify(pendingCommand.current));
      },
      message: (data) => {
        const message = JSON.parse(data) as GameMessage;
        if (message.type === 'state' || message.type === 'delta') {
          const next = applyGameUpdate(currentSnapshot.current, message);
          if (!next) {
            currentSnapshot.current = null;
            socket.current?.send(
              JSON.stringify({ type: 'sync', lastSeq: null, matchId: null }),
            );
            return false;
          }
          currentSnapshot.current = next;
          saveGameSession(room, next);
          offset.current = message.serverTime - Date.now();
          setSnapshot(next);
          setPanel(message.panel);
          setActorId(message.actorId);
          return true;
        }

        if (message.type === 'ack') {
          if (message.reply.commandId === pendingCommand.current?.commandId) {
            pendingCommand.current = null;
            setPending(false);
          }
          if (!message.reply.ok)
            setError(messages[message.reply.code] ?? '入力を受け付けられませんでした。');
        } else setError(messages[message.code] ?? '通信内容を確認できませんでした。');
        return false;
      },
    });

    const ticker = setInterval(() => setClock(Date.now() + offset.current), 100);
    return () => {
      disconnect();
      clearInterval(ticker);
      socket.current = null;
    };
  }, [room]);

  async function join(input: {
    room: string;
    name: string;
    players: number;
    questionIndex: number;
    showSelections: boolean;
  }) {
    setError('');
    setConnection('connecting');
    try {
      const response = await fetch(
        `${API_PATHS.gameJoin}?room=${encodeURIComponent(input.room)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: input.name,
            players: input.players,
            questionIndex: input.questionIndex,
            showSelections: input.showSelections,
          }),
        },
      );
      const result = (await response.json()) as { code?: string };
      if (!response.ok)
        throw new Error(messages[result.code ?? ''] ?? '参加に失敗しました。');
      currentSnapshot.current = null;
      pendingCommand.current = null;
      setPending(false);
      setSnapshot(null);
      setPanel(null);
      setRoom({ id: input.room });
      saveGameSession({ id: input.room }, null);
    } catch (error) {
      setError(error instanceof Error ? error.message : '接続に失敗しました。');
      setConnection('idle');
    }
  }

  function leave() {
    setRoom(null);
    setSnapshot(null);
    setPanel(null);
    currentSnapshot.current = null;
    pendingCommand.current = null;
    setPending(false);
    setConnection('idle');
    setError('');
    saveGameSession(null, null);
  }

  function reconnect() {
    setError('');
    setRoom((current) => (current ? { ...current } : null));
  }

  function send(type: Command['type'], payload: Command['payload'] = {}) {
    if (
      !snapshot ||
      socket.current?.readyState !== WebSocket.OPEN ||
      pendingCommand.current
    )
      return;

    const command: Command = {
      commandId: crypto.randomUUID(),
      matchId: snapshot.matchId,
      questionId: snapshot.questionId,
      type,
      payload,
    };
    pendingCommand.current = command;
    setPending(true);
    setError('');
    socket.current.send(JSON.stringify(command));
  }

  return {
    snapshot,
    panel,
    actorId,
    connection,
    error,
    pending,
    clock,
    join,
    send,
    reconnect,
    leave,
  };
}

export type Game = ReturnType<typeof useGame>;
