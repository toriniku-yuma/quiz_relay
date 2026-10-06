import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { canJoinInstance } from '../../../shared/organization';
import type { RoomView } from '../../../shared/rooms';
import { useApp } from '../../app/context';
import { navigate } from '../../app/navigation';
import { ROOMS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import DataTable from '../../components/DataTable';
import Modal from '../../components/Modal';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import LoginForm from '../auth/LoginForm';
import { useActiveSanctions } from '../moderation/useActiveSanctions';
import { useMutation } from '../moderation/useMutation';
import { playRequest } from './api';
import GuestName from './GuestName';
import PersonalSets from './PersonalSets';
import RoomEditor from './RoomEditor';
import RoomLobby from './RoomLobby';
import RoomRules from './RoomRules';
import { useRoom } from './useRoom';

export default function RoomWorkspace() {
  const { auth, organization, guest, url } = useApp();
  const sanctions = useActiveSanctions(organization.data?.sanctions ?? []);
  const instanceId = url.searchParams.get('instance') ?? '',
    id = url.searchParams.get('room') ?? '',
    invite = url.searchParams.get('invite') ?? '',
    view = url.searchParams.get('view') ?? '';
  const canCreate = canJoinInstance(
    organization.data?.instances.find((instance) => instance.id === instanceId),
    organization.data?.account,
    organization.data?.sanctions && sanctions,
    'roomCreate',
  );
  const session = useRoom(auth.user?.id ?? guest?.data?.id ?? '');
  const [rooms, setRooms] = useState<(RoomView & { memberCount: number })[]>([]),
    [info, setInfo] = useState<RoomView | null>(null),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [namePrompt, setNamePrompt] = useState(false);
  const [joinAfterName, setJoinAfterName] = useState(false);
  const [restorePrompt, setRestorePrompt] = useState(false);
  const offeredAt = useRef('');
  const joined = useMutation(
    API_PATHS.roomJoin,
    (request) => {
      const joinedRoom = String(request.room),
        joinedInstance = String(request.instanceId);
      session.join(joinedRoom, joinedInstance);
      navigate(
        `${ROOMS_PATH}?instance=${joinedInstance}&room=${joinedRoom}${auth.user ? '' : '&guest=1'}`,
      );
    },
    (path, body) =>
      playRequest(path, body, String((body as Record<string, unknown>).instanceId)),
  );
  const eligible = !!auth.user || !!instanceId || url.searchParams.get('guest') === '1';
  useEffect(() => {
    if (joinAfterName && guest?.data?.id) {
      setJoinAfterName(false);
      void joined.submit({ room: id, password, invite, instanceId });
    }
  }, [joinAfterName, guest?.data?.id, joined.submit, id, password, invite, instanceId]);
  const refresh = useCallback(async () => {
    if (!instanceId || !eligible) return;
    try {
      setRooms(
        (await playRequest<{ rooms: typeof rooms }>(API_PATHS.rooms, {}, instanceId))
          .rooms,
      );
      setError('');
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : '一覧を読み込めませんでした。',
      );
    }
  }, [instanceId, eligible]);
  useEffect(() => {
    let live = true;
    setInfo(null);
    if (id) {
      void playRequest<{ room: RoomView }>(API_PATHS.roomInfo, { room: id, invite })
        .then((response) => {
          if (live) setInfo(response.room);
        })
        .catch((caughtError) => {
          if (live) setError(caughtError.message);
        });
      if (auth.user || guest?.data?.id)
        void playRequest<{ room: RoomView }>(API_PATHS.roomView, { room: id }, instanceId)
          .then(() => {
            if (live && session.isCurrent(null)) session.join(id, instanceId);
          })
          .catch(() => {});
    } else if (eligible && view !== 'sets') void refresh();
    return () => {
      live = false;
    };
  }, [
    id,
    invite,
    instanceId,
    auth.user,
    guest?.data?.id,
    eligible,
    view,
    refresh,
    session.isCurrent,
    session.join,
  ]);
  const activeHere =
    session.active?.id === id && session.active.instanceId === instanceId;
  useEffect(() => {
    if (
      url.pathname === ROOMS_PATH &&
      activeHere &&
      session.room?.id === id &&
      session.room?.matchRoom &&
      !session.room.waiting &&
      view !== 'game' &&
      view !== 'edit' &&
      !session.restored
    )
      navigate(
        `${ROOMS_PATH}?instance=${instanceId}&room=${id}&view=game${auth.user ? '' : '&guest=1'}`,
      );
  }, [
    url.pathname,
    activeHere,
    session.room?.matchRoom,
    session.room?.id,
    session.room?.waiting,
    view,
    instanceId,
    id,
    auth.user,
    session.restored,
  ]);
  useEffect(() => {
    if (
      url.pathname === ROOMS_PATH &&
      !view &&
      session.room?.playing &&
      !session.room.waiting &&
      (session.restored || !activeHere) &&
      offeredAt.current !== url.href
    ) {
      offeredAt.current = url.href;
      setRestorePrompt(true);
    }
  }, [
    url.href,
    url.pathname,
    view,
    session.room?.playing,
    session.room?.waiting,
    session.restored,
    activeHere,
  ]);
  return (
    <>
      {session.active && (
        <div hidden={!activeHere || view === 'edit'}>
          <RoomLobby session={session} gamePage={view === 'game'} />
        </div>
      )}
      {view === 'sets' ? (
        auth.user ? (
          <PersonalSets />
        ) : (
          <LoginForm auth={auth} />
        )
      ) : view === 'create' ? (
        auth.user ? (
          <RoomEditor key={`new:${instanceId}`} instanceId={instanceId} />
        ) : (
          <>
            <p>部屋の作成にはログインが必要です。</p>
            <LoginForm auth={auth} />
          </>
        )
      ) : view === 'edit' && activeHere && session.room ? (
        <RoomEditor key={`edit:${id}`} instanceId={instanceId} room={session.room} />
      ) : id && !activeHere ? (
        <Panel title={info?.settings.name ?? '部屋への参加'}>
          {info && (
            <>
              <RoomRules settings={info.settings} />
              {info.playing && <p>対戦中です。入室後はロビーで次の試合を待ちます。</p>}
              {(auth.user || info.guestAllowed) && (
                <form
                  className="mt-4 grid gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!auth.user && !guest?.data?.name) setNamePrompt(true);
                    else void joined.submit({ room: id, password, invite, instanceId });
                  }}
                >
                  {info.password && (
                    <TextField
                      id="join-password"
                      label="部屋のパスワード"
                      placeholder="招待者から教わったパスワード"
                      type="password"
                      autoComplete="off"
                      value={password}
                      disabled={joined.busy || joined.uncertain}
                      maxLength={128}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  )}
                  <Button type="submit" tone="primary" disabled={joined.busy}>
                    {joined.uncertain
                      ? '同じ内容で再試行'
                      : auth.user
                        ? '入室する'
                        : 'ゲストで入室する'}
                  </Button>
                </form>
              )}
              {!auth.user && (
                <div className="mt-6">
                  <LoginForm auth={auth} />
                </div>
              )}
            </>
          )}
          {(error || joined.error) && <p role="alert">{error || joined.error}</p>}
          {joined.uncertain && <p>参加結果が不明です。同じ内容で再試行してください。</p>}
        </Panel>
      ) : !id && !view ? (
        <>
          <div className="mb-4 flex flex-wrap gap-4">
            {auth.user && (
              <>
                {canCreate && (
                  <a
                    className="underline"
                    href={`${ROOMS_PATH}?instance=${instanceId}&view=create`}
                  >
                    部屋を作る
                  </a>
                )}
                <a
                  className="underline"
                  href={`${ROOMS_PATH}?instance=${instanceId}&view=sets`}
                >
                  自分の部屋用問題セット
                </a>
              </>
            )}
            <Button onClick={refresh}>一覧を更新</Button>
          </div>
          {!instanceId ? (
            <p>インスタンスを選んでください。</p>
          ) : (
            <Panel title="公開部屋一覧">
              <DataTable label="公開部屋" columns={['部屋名', '人数', '状態', '参加']}>
                {rooms.map((room) => (
                  <tr key={room.id}>
                    <td>
                      {room.settings.name}
                      {room.password ? '（パスワードあり）' : ''}
                    </td>
                    <td>
                      {room.memberCount} /{' '}
                      {room.settings.capacity + (room.settings.presenter ? 1 : 0)}
                    </td>
                    <td>{room.playing ? '対戦中' : 'ロビー'}</td>
                    <td>
                      <a
                        className="underline"
                        href={`${ROOMS_PATH}?instance=${instanceId}&room=${room.id}${auth.user ? '' : '&guest=1'}`}
                      >
                        ルールを確認して参加
                      </a>
                    </td>
                  </tr>
                ))}
              </DataTable>
              {!rooms.length && <p>公開中の部屋はありません。</p>}
              {error && <p role="alert">{error}</p>}
            </Panel>
          )}
        </>
      ) : null}
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
      {!auth.user && guest?.error && <p role="alert">{guest.error}</p>}
      {restorePrompt &&
        url.pathname === ROOMS_PATH &&
        !view &&
        session.room?.playing &&
        !session.room.waiting && (
          <Modal
            title="参加中の部屋マッチがあります"
            onClose={() => setRestorePrompt(false)}
          >
            <Button
              tone="primary"
              onClick={() => {
                setRestorePrompt(false);
                session.resume();
                navigate(
                  `${ROOMS_PATH}?instance=${session.active?.instanceId}&room=${session.active?.id}&view=game${auth.user ? '' : '&guest=1'}`,
                );
              }}
            >
              参加中の試合へ戻る
            </Button>
          </Modal>
        )}
      {auth.user && !organization.data && <p role="status">組織情報を確認しています。</p>}
    </>
  );
}
