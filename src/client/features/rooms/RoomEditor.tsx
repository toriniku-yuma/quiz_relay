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
  request = playRequest,
  onSaved,
  foreign = false,
}: {
  instanceId: string;
  room?: RoomView;
  request?: typeof playRequest;
  onSaved?: (id: string) => void;
  foreign?: boolean;
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
    [sharedSources, setSharedSources] = useState<{ key: string; name: string }[]>([]),
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
    request,
  );
  const send = (path: string, body: object) => request(path, body, instanceId);
  const mutation = useMutation(
    room ? API_PATHS.roomMutate : API_PATHS.roomCreate,
    () =>
      onSaved ? onSaved(id) : navigate(`${ROOMS_PATH}?instance=${instanceId}&room=${id}`),
    send,
  );
  const locked = mutation.busy || mutation.uncertain || saveSet.busy || saveSet.uncertain;
  useEffect(() => {
    let active = true;
    void request<{
      categories: typeof categories;
      sharedSources: typeof sharedSources;
      config: CasualSettings;
    }>(API_PATHS.roomOptions, {}, instanceId)
      .then((response) => {
        if (active) {
          setCategories(response.categories);
          setSharedSources(response.sharedSources);
          setConfig(response.config);
          if (!editing)
            setSettings((currentSettings) => ({
              ...currentSettings,
              guests: response.config.roomGuests,
            }));
        }
      })
      .catch((caughtError) => {
        if (active) setError(caughtError.message);
      });
    if (auth.user || foreign)
      void request<{ sets: PersonalSet[] }>(API_PATHS.personalSets)
        .then((response) => {
          if (active) setSets(response.sets);
        })
        .catch((caughtError) => {
          if (active) setError(caughtError.message);
        });
    if ((auth.user || foreign) && roomId)
      void request<{ questions: BroughtQuestion[] }>(
        API_PATHS.roomOriginals,
        { room: roomId },
        instanceId,
      )
        .then((response) => {
          if (active) setQuestions(response.questions);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [instanceId, auth.user, editing, roomId, foreign, request]);
  return (
    <Panel title={room ? '部屋の設定を変更' : '部屋を作る'}>
      <form
        className="mt-4 grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
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
          } catch (caughtError) {
            setError(
              caughtError instanceof Error
                ? caughtError.message
                : '入力を確認してください。',
            );
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
            onChange={(event) => setSettings({ ...settings, name: event.target.value })}
          />
          <label className="flex gap-3">
            <Checkbox
              checked={settings.public}
              onChange={(event) =>
                setSettings({ ...settings, public: event.target.checked })
              }
            />
            公開部屋一覧に載せる
          </label>
          <label className="flex gap-3">
            <Checkbox
              checked={settings.guests}
              disabled={!config?.roomGuests}
              onChange={(event) =>
                setSettings({ ...settings, guests: event.target.checked })
              }
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
            onChange={(event) =>
              setSettings({ ...settings, capacity: event.target.valueAsNumber })
            }
          />
          <label className="flex gap-3">
            <Checkbox
              checked={settings.presenter}
              onChange={(event) =>
                setSettings({ ...settings, presenter: event.target.checked })
              }
            />
            部屋主は出題専任になる（回答兼任にする場合はオフ）
          </label>
          <label>
            勝利方式
            <select
              className="ml-3 border border-line p-3"
              value={settings.winMode}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  winMode: event.target.value as 'target' | 'questions',
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
            onChange={(event) =>
              setSettings({ ...settings, count: event.target.valueAsNumber })
            }
          />
          <label className="flex gap-3">
            <Checkbox
              checked={settings.mistakes === null}
              onChange={(event) =>
                setSettings({ ...settings, mistakes: event.target.checked ? null : 3 })
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
              onChange={(event) =>
                setSettings({ ...settings, mistakes: event.target.valueAsNumber })
              }
            />
          )}
          <label>
            出題する問題
            <select
              className="ml-3 border border-line p-3"
              value={settings.source}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  source: event.target.value as 'normal' | 'original',
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
              {sharedSources.length > 0 && (
                <fieldset className="grid gap-3">
                  <legend>使用する共有元</legend>
                  <p className="text-sm">
                    選んだ共有元の利用可能な問題を加えます。共有停止・取得失敗中の問題は使いません。
                  </p>
                  {sharedSources.map((source) => (
                    <label key={source.key} className="flex gap-2">
                      <Checkbox
                        checked={(settings.sharedSources ?? []).includes(source.key)}
                        onChange={(event) =>
                          setSettings({
                            ...settings,
                            sharedSources: event.target.checked
                              ? [...(settings.sharedSources ?? []), source.key]
                              : (settings.sharedSources ?? []).filter(
                                  (key) => key !== source.key,
                                ),
                          })
                        }
                      />
                      {source.name}
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="flex flex-wrap gap-4">
                {categories.map((category) => (
                  <label key={category.id} className="flex gap-2">
                    <Checkbox
                      checked={settings.categories.includes(category.id)}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          categories: event.target.checked
                            ? [...settings.categories, category.id]
                            : settings.categories.filter((id) => id !== category.id),
                        })
                      }
                    />
                    {category.name}
                  </label>
                ))}
              </div>
              <div className="flex gap-4">
                {['易', '中', '難'].map((label, difficulty) => (
                  <label key={label} className="flex gap-2">
                    <Checkbox
                      checked={settings.difficulties.includes(difficulty)}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          difficulties: event.target.checked
                            ? [...settings.difficulties, difficulty]
                            : settings.difficulties.filter(
                                (selectedDifficulty) => selectedDifficulty !== difficulty,
                              ),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </>
          ) : auth.user || foreign ? (
            <>
              <label>
                自分の保存済みセット
                <select
                  className="ml-3 border border-line p-3"
                  defaultValue=""
                  onChange={(event) => {
                    const set = sets.find(
                      (questionSet) => questionSet.id === event.target.value,
                    );
                    setQuestions(set ? structuredClone(set.questions) : []);
                    setChanged(true);
                  }}
                >
                  <option value="">直接入力する</option>
                  {sets.map((questionSet) => (
                    <option key={questionSet.id} value={questionSet.id}>
                      {questionSet.name}
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
                onChange={(updatedQuestions) => {
                  setQuestions(updatedQuestions);
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
                onChange={(event) => setSaveName(event.target.value)}
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
                  } catch (caughtError) {
                    setError(
                      caughtError instanceof Error
                        ? caughtError.message
                        : '問題を確認してください。',
                    );
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
                onChange={(event) => setChangePassword(event.target.checked)}
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
              onChange={(event) => setPassword(event.target.value)}
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
