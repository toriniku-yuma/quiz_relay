import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { ForeignAccount, ForeignSession } from '../../../shared/participation';
import type { RoomView } from '../../../shared/rooms';
import { ROOMS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import { useMutation } from '../moderation/useMutation';
import { PlayRequestError, type playRequest } from '../rooms/api';
import RoomEditor from '../rooms/RoomEditor';
import RoomLobby from '../rooms/RoomLobby';
import { useRoom } from '../rooms/useRoom';
import {
  beginForeignRoomEntry,
  clearForeignRoomEntry,
  readForeignRoomEntry,
  restartForeignRoomEntry,
} from './roomEntry';
import { foreignRequest } from './useForeignParticipation';

export default function ForeignRooms({
  session,
  entry,
  onEnded,
}: {
  session?: ForeignSession;
  entry?: { account: ForeignAccount; instanceId: string; instanceName: string };
  onEnded: () => void;
}) {
  const instanceId = session?.instanceId ?? entry?.instanceId ?? '',
    instanceName = session?.instanceName ?? entry?.instanceName ?? '',
    name = session?.name ?? entry?.account.name ?? '',
    account = entry?.account;
  const restartEntry = useRef(false);
  const request: typeof playRequest = useCallback(
    async <T,>(path: string, body: object = {}) => {
      const action =
        path === API_PATHS.rooms
          ? 'list'
          : path === API_PATHS.personalSets
            ? 'sets'
            : path.split('/').at(-1);
      if (
        session &&
        account &&
        restartEntry.current &&
        (action === 'create' || action === 'join')
      ) {
        await restartForeignRoomEntry(session, account, instanceId, action, body);
        return new Promise<T>(() => {});
      }
      if (!session) {
        if ((action === 'create' || action === 'join') && account) {
          beginForeignRoomEntry(account, instanceId, action, body);
          // Navigation returns to this page and retries the saved, same operation.
          return new Promise<T>(() => {});
        }
        return foreignRequest<T>(`${API_PATHS.foreignLoginRooms}/${action}`, {
          instanceId,
          ...(Object.keys(body).length ? { body } : {}),
        });
      }
      let result: T;
      try {
        result = await foreignRequest<T>(
          `${API_PATHS.participationRooms}/${action}`,
          body,
          session.reservationId,
        );
      } catch (error) {
        if (
          (action === 'create' || action === 'join') &&
          error instanceof PlayRequestError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 429].includes(error.status)
        )
          restartEntry.current = true;
        throw error;
      }
      if (action === 'leave') onEnded();
      return result;
    },
    [session, account, instanceId, onEnded],
  );
  const room = useRoom(
    session ? `federation:${session.reservationId}` : `foreign-entry:${instanceId}`,
    {
      request,
      lobbySocket: `${API_PATHS.participationRoomSocket}?reservation=${session?.reservationId ?? ''}`,
      gameSocket: `${API_PATHS.participationSocket}?reservation=${session?.reservationId ?? ''}`,
    },
  );
  const [rooms, setRooms] = useState<RoomView[]>([]),
    [error, setError] = useState(''),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState(false),
    [password, setPassword] = useState(''),
    [inviteRoom, setInviteRoom] = useState(''),
    [invite, setInvite] = useState('');
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (session?.room && !room.active) room.join(session.room, instanceId);
  }, [session?.room, instanceId, room.active, room.join]);
  const [retryEntry, setRetryEntry] = useState(0);
  const pendingEntry = useRef('');
  useEffect(() => {
    const attempt = `${session?.reservationId}:${retryEntry}`;
    if (!session || pendingEntry.current === attempt) return;
    const pending = readForeignRoomEntry(session);
    if (!pending) return;
    pendingEntry.current = attempt;
    let active = true;
    void request<{ room: RoomView }>(
      pending.action === 'create' ? API_PATHS.roomCreate : API_PATHS.roomJoin,
      pending.body,
    )
      .then((result) => {
        if (!active) return;
        clearForeignRoomEntry();
        room.join(result.room.id, instanceId);
        setError('');
      })
      .catch((error) => {
        if (!active) return;
        setError(
          error instanceof Error ? error.message : '部屋への参加を確認できません。',
        );
        pendingEntry.current = '';
      });
    return () => {
      active = false;
      pendingEntry.current = '';
    };
  }, [session, room.join, instanceId, retryEntry, request]);
  const refresh = useCallback(async () => {
    try {
      const value = await request<{ rooms: RoomView[] }>(API_PATHS.rooms);
      setRooms(value.rooms);
      setError('');
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '部屋一覧を取得できませんでした。',
      );
    }
  }, [request]);
  useEffect(() => {
    if (!room.active) void refresh();
  }, [room.active, refresh]);
  const join = useMutation(
    API_PATHS.roomJoin,
    (input) => room.join(String(input.room), instanceId),
    request,
  );
  const foreign = {
    actorId: session?.actorId ?? '',
    href: `${ROOMS_PATH}?${new URLSearchParams({
      instance: instanceId,
    })}`,
    homeHistory: `${session?.homeOrigin ?? entry?.account.homeOrigin}/history/?external=1`,
    onEdit: () => setEditing(true),
    onReturn: () => setEditing(false),
    onClosed: onEnded,
  };
  return (
    <div className="grid gap-5">
      <p>
        {instanceName} ／ 表示名：{name}
      </p>
      {room.active ? (
        editing ? (
          <RoomEditor
            key={`edit:${room.active.id}`}
            instanceId={instanceId}
            room={room.room ?? undefined}
            request={request}
            foreign
            onSaved={() => {
              setEditing(false);
              void room.refresh();
            }}
          />
        ) : (
          <RoomLobby
            session={room}
            gamePage={!!room.room?.matchRoom && !room.room.waiting}
            foreign={foreign}
          />
        )
      ) : (
        <>
          <Panel title="開催先の部屋">
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void refresh()}>部屋一覧を更新</Button>
              <Button
                tone="primary"
                disabled={join.busy || join.uncertain}
                onClick={() => setCreating(!creating)}
              >
                部屋を作る
              </Button>
            </div>
            {error && <p role="alert">{error}</p>}
            {session && readForeignRoomEntry(session) && error && (
              <Button
                disabled={!!pendingEntry.current}
                onClick={() => setRetryEntry((value) => value + 1)}
              >
                同じ部屋への参加を再試行
              </Button>
            )}
            <TextField
              id="foreign-room-password"
              label="部屋のパスワード（設定されている場合）"
              type="password"
              value={password}
              maxLength={128}
              onChange={(event) => setPassword(event.target.value)}
            />
            {rooms.length ? (
              <ul className="grid gap-3">
                {rooms.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-3">
                    <span>{item.settings.name}</span>
                    <Button
                      disabled={join.busy || join.uncertain}
                      onClick={() =>
                        void join.submit({ room: item.id, password, invite: '' })
                      }
                    >
                      この部屋に入る
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>公開部屋はありません。</p>
            )}
            <details>
              <summary>招待から入る</summary>
              <div className="mt-3 grid gap-3">
                <TextField
                  id="foreign-invite-room"
                  label="招待URL"
                  value={inviteRoom}
                  onChange={(event) => {
                    setInviteRoom(event.target.value);
                    try {
                      const url = new URL(event.target.value);
                      if (
                        url.origin !== location.origin ||
                        url.searchParams.get('instance') !== instanceId
                      )
                        throw new Error();
                      setInvite(url.searchParams.get('invite') ?? '');
                    } catch {
                      setInvite('');
                    }
                  }}
                />
                <Button
                  disabled={join.busy || join.uncertain || !invite}
                  onClick={() => {
                    try {
                      const url = new URL(inviteRoom);
                      void join.submit({
                        room: url.searchParams.get('room'),
                        password,
                        invite,
                      });
                    } catch {
                      setError('開催先の招待URLを入力してください。');
                    }
                  }}
                >
                  招待された部屋に入る
                </Button>
              </div>
            </details>
            {join.error && <p role="alert">{join.error}</p>}
            {join.uncertain && (
              <Button disabled={join.busy} onClick={() => void join.submit({})}>
                同じ入室操作を再試行
              </Button>
            )}
          </Panel>
          {creating && (
            <RoomEditor
              instanceId={instanceId}
              request={request}
              foreign
              onSaved={(id) => {
                setCreating(false);
                room.join(id, instanceId);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
