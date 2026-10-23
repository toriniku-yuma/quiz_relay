import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { RoomView } from '../../../shared/rooms';
import { settings } from '../../../shared/settings';
import { connectGameSocket } from '../game/connection';
import { useGame } from '../game/useGame';
import { useMutation } from '../moderation/useMutation';
import { OrganizationRequestError } from '../organization/useOrganization';
import { playRequest } from './api';

export function useRoom(
  identity: string,
  foreign?: { request: typeof playRequest; lobbySocket: string; gameSocket: string },
) {
  const request = foreign?.request ?? playRequest;
  const key = `quiz-relay-room:${identity}`;
  const [active, setActive] = useState<{ id: string; instanceId: string } | null>(() => {
    try {
      return identity ? JSON.parse(sessionStorage.getItem(key) ?? 'null') : null;
    } catch {
      return null;
    }
  });
  const [room, setRoom] = useState<RoomView | null>(null),
    [error, setError] = useState(''),
    [lobbyError, setLobbyError] = useState(''),
    [connectionAttempt, setConnectionAttempt] = useState(0),
    [connection, setConnection] = useState('idle');
  const game = useGame(
    'formal',
    `room:${identity}`,
    active?.instanceId ?? '',
    foreign?.gameSocket,
  );
  const { attach } = game;
  const leaveGame = game.leave;
  const current = useRef(active);
  const [restored, setRestored] = useState(!!active);
  current.current = active;
  const isCurrent = useCallback(
    (id: unknown) => (current.current?.id ?? null) === id,
    [],
  );
  useEffect(() => {
    try {
      const saved = identity ? JSON.parse(sessionStorage.getItem(key) ?? 'null') : null;
      current.current = saved;
      setActive(saved);
      setRestored(!!saved);
    } catch {
      current.current = null;
      setActive(null);
    }
    setRoom(null);
  }, [identity, key]);
  const refresh = useCallback(async () => {
    if (!active) return;
    const result = await request<{ room: RoomView }>(
      API_PATHS.roomView,
      { room: active.id },
      active.instanceId,
    );
    if (current.current === active) setRoom(result.room);
  }, [active, request]);
  const join = useCallback(
    (id: string, instanceId: string) => {
      const next = { id, instanceId };
      current.current = next;
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* The live session does not require browser storage. */
      }
      setRoom(null);
      leaveGame();
      setActive(next);
      setRestored(false);
      setError('');
      setLobbyError('');
    },
    [key, leaveGame],
  );
  const leave = useCallback(() => {
    current.current = null;
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
    setActive(null);
    setRoom(null);
    leaveGame();
  }, [key, leaveGame]);
  const reconnect = useCallback(() => {
    setLobbyError('');
    setConnectionAttempt((attempt) => attempt + 1);
  }, []);
  const exit = useMutation(
    API_PATHS.roomLeave,
    (request) => {
      if (current.current?.id === request.room) leave();
    },
    (path, body) =>
      request(path, body, String((body as Record<string, unknown>).instanceId)),
  );
  const retryExit = useRef(exit.submit);
  retryExit.current = exit.submit;
  useEffect(() => {
    if (!exit.uncertain || exit.busy) return;
    const timer = setTimeout(() => void retryExit.current({}), 1500);
    return () => clearTimeout(timer);
  }, [exit.uncertain, exit.busy]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 手動再接続では参加先・対戦状態を変えず、ロビー接続だけを作り直す。
  useEffect(() => {
    if (!active) return;
    const url = new URL(foreign?.lobbySocket ?? API_PATHS.roomSocket, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', active.id);
    url.searchParams.set('instance', active.instanceId);
    let live = true,
      closed = false,
      received = false;
    const stillActive = () => live && current.current === active;
    void request<{ room: RoomView }>(
      API_PATHS.roomView,
      { room: active.id },
      active.instanceId,
    )
      .then((response) => {
        if (stillActive() && !received) {
          closed = response.room.closed;
          setRoom(response.room);
          setLobbyError('');
        }
      })
      .catch((caughtError) => {
        if (!stillActive() || received) return;
        if (['ROOM_CLOSED', 'ROOM_NOT_FOUND'].includes(caughtError.code)) {
          leave();
          return;
        }
        setLobbyError(caughtError.message);
      });
    const disconnect = connectGameSocket(url, {
      sync: () => 'sync',
      opened: () => {},
      status: (value) => {
        if (stillActive()) setConnection(value);
      },
      error: (value) => {
        if (stillActive()) setLobbyError(value);
      },
      released: () => {
        if (stillActive()) leave();
      },
      finished: () => closed,
      message: (data) => {
        if (!stillActive()) return false;
        const value = JSON.parse(data) as { type?: string; room?: RoomView };
        if (value.type !== 'lobby' || !value.room || value.room.id !== active.id)
          return false;
        closed = value.room.closed;
        received = true;
        setRoom(value.room);
        setLobbyError('');
        return true;
      },
    });
    return () => {
      live = false;
      disconnect();
    };
  }, [active, leave, request, foreign?.lobbySocket, connectionAttempt]);
  useEffect(() => {
    if (!room?.matchRoom || !active || room.id !== active.id) return;
    const target = active;
    let live = true;
    let retry: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + settings.connection.retryWindowMs;
    const stillActive = () => live && current.current === active;
    const timeout = setTimeout(() => {
      if (stillActive()) {
        setError(
          '試合への接続を復旧できませんでした。通信状態を確認して再読み込みしてください。',
        );
        live = false;
      }
      clearTimeout(retry);
    }, settings.connection.retryWindowMs);
    async function connect() {
      if (!stillActive()) return;
      let response: { room: string };
      try {
        response = await request<{ room: string }>(
          API_PATHS.roomGame,
          { room: target.id },
          target.instanceId,
        );
      } catch (caughtError) {
        if (!stillActive()) return;
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : '試合への接続情報を取得できませんでした。',
        );
        const transient =
          (caughtError instanceof OrganizationRequestError &&
            (caughtError.status >= 500 || caughtError.status === 408)) ||
          caughtError instanceof TypeError ||
          (caughtError instanceof DOMException && caughtError.name === 'TimeoutError');
        if (transient && Date.now() + settings.connection.retryIntervalMs < deadline)
          retry = setTimeout(() => void connect(), settings.connection.retryIntervalMs);
        else {
          clearTimeout(timeout);
          live = false;
        }
        return;
      }
      if (!stillActive()) return;
      clearTimeout(timeout);
      setError('');
      attach(response.room);
    }
    void connect();
    return () => {
      live = false;
      clearTimeout(retry);
      clearTimeout(timeout);
    };
  }, [room?.matchRoom, room?.id, active, attach, request]);
  return {
    request,
    active,
    room,
    game,
    error: error || lobbyError,
    connection,
    reconnect,
    refresh,
    join,
    leave,
    exit,
    restored,
    isCurrent,
    resume: () => setRestored(false),
  };
}
