import { useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import {
  type BroughtQuestion,
  type CasualSettings,
  newRoomSettings,
  type RoomView,
  validateBroughtSet,
  validateRoomSettings,
} from '../../../shared/rooms';
import { useApp } from '../../app/context';
import { navigate } from '../../app/navigation';
import { ROOMS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import { useMutation } from '../moderation/useMutation';
import { playRequest } from './api';
import BroughtEditor from './BroughtEditor';
import type { PersonalSet } from './PersonalSets';

export default function RoomEditor({
  instanceId,
  room,
}: {
  instanceId: string;
  room?: RoomView;
}) {
  const { auth } = useApp();
  const editing = !!room,
    roomId = room?.id;
  const [id] = useState(room?.id ?? crypto.randomUUID()),
    [settings, setSettings] = useState(room?.settings ?? newRoomSettings(false)),
    [password, setPassword] = useState(''),
    [changePassword, setChangePassword] = useState(!room),
    [questions, setQuestions] = useState<BroughtQuestion[]>([]),
    [changed, setChanged] = useState(false),
    [sets, setSets] = useState<PersonalSet[]>([]),
    [categories, setCategories] = useState<{ id: string; name: string }[]>([]),
    [config, setConfig] = useState<CasualSettings | null>(null),
    [error, setError] = useState('');
  const [revision] = useState(room?.revision);
  const [saveName, setSaveName] = useState(''),
    [saveId] = useState(crypto.randomUUID()),
    [saveRevision, setSaveRevision] = useState(0);
  const saveSet = useMutation(
    API_PATHS.personalSets,
    (request) => {
      setSaveRevision(Number(request.revision) + 1);
    },
    playRequest,
  );
  const send = (path: string, body: object) => playRequest(path, body, instanceId);
  const mutation = useMutation(
    room ? API_PATHS.roomMutate : API_PATHS.roomCreate,
    () => navigate(`${ROOMS_PATH}?instance=${instanceId}&room=${id}`),
    send,
  );
  const locked = mutation.busy || mutation.uncertain || saveSet.busy || saveSet.uncertain;
  useEffect(() => {
    let active = true;
    void playRequest<{ categories: typeof categories; config: CasualSettings }>(
      API_PATHS.roomOptions,
      {},
      instanceId,
    )
      .then((v) => {
        if (active) {
          setCategories(v.categories);
          setConfig(v.config);
          if (!editing) setSettings((s) => ({ ...s, guests: v.config.roomGuests }));
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    if (auth.user)
      void playRequest<{ sets: PersonalSet[] }>(API_PATHS.personalSets)
        .then((r) => {
          if (active) setSets(r.sets);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    if (auth.user && roomId)
      void playRequest<{ questions: BroughtQuestion[] }>(
        API_PATHS.roomOriginals,
        { room: roomId },
        instanceId,
      )
        .then((r) => {
          if (active) setQuestions(r.questions);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [instanceId, auth.user, editing, roomId]);
  return (
    <Panel title={room ? '部屋の設定を変更' : '部屋を作る'}>
      <form
        className="mt-4 grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const fixed = validateRoomSettings(settings);
            const content =
              fixed.source === 'original' && (!room || changed)
                ? { questions: validateBroughtSet(questions) }
                : {};
            setError('');
            void mutation.submit({
              room: id,
              settings: fixed,
              ...content,
              ...(changePassword ? { password } : {}),
              ...(room ? { action: 'settings', revision } : {}),
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : '入力を確認してください。');
          }
        }}
      >
        <fieldset disabled={locked || !config} className="grid gap-4">
          <TextField
            id="room-name"
            label="部屋名"
            placeholder="例：週末のクイズ会"
            value={settings.name}
            required
            maxLength={80}
            onChange={(e) => setSettings({ ...settings, name: e.target.value })}
          />
          <label className="flex gap-3">
            <Checkbox
              checked={settings.public}
              onChange={(e) => setSettings({ ...settings, public: e.target.checked })}
            />
            公開部屋一覧に載せる
          </label>
          <label className="flex gap-3">
            <Checkbox
              checked={settings.guests}
              disabled={!config?.roomGuests}
              onChange={(e) => setSettings({ ...settings, guests: e.target.checked })}
            />
            ゲスト参加を許可
          </label>
          <TextField
            id="room-capacity"
            label="回答者の上限（2〜8人）"
            placeholder="例：8"
            type="number"
            min={2}
            max={8}
            value={settings.capacity}
            onChange={(e) =>
              setSettings({ ...settings, capacity: e.target.valueAsNumber })
            }
          />
          <label className="flex gap-3">
            <Checkbox
              checked={settings.presenter}
              onChange={(e) => setSettings({ ...settings, presenter: e.target.checked })}
            />
            部屋主は出題専任になる（回答兼任にする場合はオフ）
          </label>
          <label>
            勝利方式
            <select
              className="ml-3 border border-line p-3"
              value={settings.winMode}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  winMode: e.target.value as 'target' | 'questions',
                })
              }
            >
              <option value="target">指定正解数の先取</option>
              <option value="questions">指定問題数で競う</option>
            </select>
          </label>
          <TextField
            id="room-count"
            label={
              settings.winMode === 'target' ? '先取正解数（1〜100）' : '出題数（1〜100）'
            }
            placeholder="例：7"
            type="number"
            min={1}
            max={100}
            value={settings.count}
            onChange={(e) => setSettings({ ...settings, count: e.target.valueAsNumber })}
          />
          <label className="flex gap-3">
            <Checkbox
              checked={settings.mistakes === null}
              onChange={(e) =>
                setSettings({ ...settings, mistakes: e.target.checked ? null : 3 })
              }
            />
            失格なし
          </label>
          {settings.mistakes !== null && (
            <TextField
              id="room-mistakes"
              label="失格するお手つき回数（1〜100）"
              placeholder="例：3"
              type="number"
              min={1}
              max={100}
              value={settings.mistakes}
              onChange={(e) =>
                setSettings({ ...settings, mistakes: e.target.valueAsNumber })
              }
            />
          )}
          <label>
            出題する問題
            <select
              className="ml-3 border border-line p-3"
              value={settings.source}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  source: e.target.value as 'normal' | 'original',
                })
              }
            >
              <option value="normal">通常問題</option>
              <option value="original">持込問題</option>
            </select>
          </label>
          {settings.source === 'normal' ? (
            <>
              <p>カテゴリを選ばない場合はすべてを使います。</p>
              <div className="flex flex-wrap gap-4">
                {categories.map((c) => (
                  <label key={c.id} className="flex gap-2">
                    <Checkbox
                      checked={settings.categories.includes(c.id)}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          categories: e.target.checked
                            ? [...settings.categories, c.id]
                            : settings.categories.filter((id) => id !== c.id),
                        })
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </div>
              <div className="flex gap-4">
                {['易', '中', '難'].map((label, d) => (
                  <label key={label} className="flex gap-2">
                    <Checkbox
                      checked={settings.difficulties.includes(d)}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          difficulties: e.target.checked
                            ? [...settings.difficulties, d]
                            : settings.difficulties.filter((v) => v !== d),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </>
          ) : auth.user ? (
            <>
              <label>
                自分の保存済みセット
                <select
                  className="ml-3 border border-line p-3"
                  defaultValue=""
                  onChange={(e) => {
                    const set = sets.find((s) => s.id === e.target.value);
                    setQuestions(set ? structuredClone(set.questions) : []);
                    setChanged(true);
                  }}
                >
                  <option value="">直接入力する</option>
                  {sets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {room?.settings.source === 'original' && !changed && (
                <p>
                  変更しなければ現在の持込問題を使います。作成者以外には内容を表示しません。
                </p>
              )}
              <BroughtEditor
                questions={questions}
                onChange={(q) => {
                  setQuestions(q);
                  setChanged(true);
                }}
                disabled={locked}
              />
              <TextField
                id="room-save-set"
                label="自分のセットにも保存する場合の名前（任意）"
                placeholder="例：週末用の問題"
                value={saveName}
                maxLength={80}
                onChange={(e) => setSaveName(e.target.value)}
              />
              <Button
                disabled={saveSet.busy || !saveName.trim()}
                onClick={() => {
                  try {
                    void saveSet.submit({
                      action: 'save',
                      id: saveId,
                      revision: saveRevision,
                      name: saveName,
                      questions: validateBroughtSet(questions),
                    });
                  } catch (e) {
                    setError(e instanceof Error ? e.message : '問題を確認してください。');
                  }
                }}
              >
                {saveSet.uncertain ? '同じ内容で保存を再試行' : '自分のセットに保存'}
              </Button>
              {saveRevision > 0 && <p role="status">自分のセットに保存しました。</p>}
              <a
                className="underline"
                href={`${ROOMS_PATH}?instance=${instanceId}&view=sets`}
              >
                自分の問題セットを保存・編集する
              </a>
            </>
          ) : (
            <p>現在の持込問題を使います。新しい持込問題の作成にはログインが必要です。</p>
          )}
          {room && (
            <label className="flex gap-3">
              <Checkbox
                checked={changePassword}
                onChange={(e) => setChangePassword(e.target.checked)}
              />
              パスワードを変更する
            </label>
          )}
          {changePassword && (
            <TextField
              id="room-password"
              label="パスワード（任意・空欄で設定なし）"
              placeholder="任意のパスワード"
              type="password"
              autoComplete="new-password"
              value={password}
              maxLength={128}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          <p>
            公開範囲・パスワードの変更は新しい入室に適用します。設定変更後、回答者の準備完了をやり直します。
          </p>
        </fieldset>
        {(error || mutation.error || saveSet.error) && (
          <p role="alert">{error || mutation.error || saveSet.error}</p>
        )}
        {mutation.uncertain && (
          <p>
            保存結果を確認できていません。入力を維持して同じ内容で再試行してください。
          </p>
        )}
        <Button type="submit" tone="primary" disabled={mutation.busy || !config}>
          {mutation.uncertain
            ? '同じ内容で再試行'
            : room
              ? '保存してロビーへ戻る'
              : '部屋を作る'}
        </Button>
      </form>
    </Panel>
  );
}
