import { useCallback, useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { RoomView } from '../../../shared/rooms';
import { connectGameSocket } from '../game/connection';
import { useGame } from '../game/useGame';
import { playRequest } from './api';

export function useRoom(identity: string) {
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
    [connection, setConnection] = useState('idle');
  const game = useGame('formal', `room:${identity}`, active?.instanceId ?? '');
  const { attach } = game;
  const leaveGame = game.leave;
  useEffect(() => {
    leaveGame();
    try {
      setActive(identity ? JSON.parse(sessionStorage.getItem(key) ?? 'null') : null);
    } catch {
      setActive(null);
    }
    setRoom(null);
  }, [identity, key, leaveGame]);
  const refresh = useCallback(async () => {
    if (!active) return;
    const result = await playRequest<{ room: RoomView }>(
      API_PATHS.roomView,
      { room: active.id },
      active.instanceId,
    );
    setRoom(result.room);
  }, [active]);
  const join = useCallback(
    (id: string, instanceId: string) => {
      const next = { id, instanceId };
      sessionStorage.setItem(key, JSON.stringify(next));
      setActive(next);
      setError('');
    },
    [key],
  );
  const leave = () => {
    sessionStorage.removeItem(key);
    setActive(null);
    setRoom(null);
    game.leave();
  };
  useEffect(() => {
    if (!active) return;
    const url = new URL(API_PATHS.roomSocket, location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', active.id);
    url.searchParams.set('instance', active.instanceId);
    let live = true;
    void playRequest<{ room: RoomView }>(
      API_PATHS.roomView,
      { room: active.id },
      active.instanceId,
    )
      .then((r) => {
        if (live) setRoom(r.room);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    const disconnect = connectGameSocket(url, {
      sync: () => 'sync',
      opened: () => {},
      status: setConnection,
      error: setError,
      message: (data) => {
        const value = JSON.parse(data) as { type?: string; room?: RoomView };
        if (value.type !== 'lobby' || !value.room || value.room.id !== active.id)
          return false;
        setRoom(value.room);
        return true;
      },
    });
    return () => {
      live = false;
      disconnect();
    };
  }, [active]);
  useEffect(() => {
    if (!room?.matchRoom || !active) return;
    let live = true;
    void playRequest<{ room: string }>(
      API_PATHS.roomGame,
      { room: active.id },
      active.instanceId,
    )
      .then((r) => {
        if (live) attach(r.room);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [room?.matchRoom, active, attach]);
  return { active, room, game, error, connection, refresh, join, leave };
}
