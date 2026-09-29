import { useState } from 'react';
import type { QuestionOverview, SubmissionMode } from '../../../shared/questions';
import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import TextField from '../../components/TextField';
import { type QuestionPage, questionHref } from './pages';

export default function QuestionAdministration({
  data,
  busy,
  mutate,
  page,
  instanceId,
  selectedId,
}: {
  page: QuestionPage;
  instanceId: string;
  selectedId: string | null;
  data: QuestionOverview;
  busy: boolean;
  mutate: (body: object) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('');
  const [destination, setDestination] = useState('');
  const [actor, setActor] = useState('');
  const [mode, setMode] = useState<SubmissionMode>(data.settings.mode);
  const [waitDays, setWaitDays] = useState(data.settings.authorWaitDays);
  const [showAuthor, setShowAuthor] = useState(data.settings.showAuthor);
  return (
    <div className="grid gap-6">
      {(page === 'qualification' || (page === 'authors' && data.manageAuthors)) && (
        <section className="grid gap-3 border border-line p-4">
          <h2 className="text-xl font-bold">作問者資格</h2>
          <p>
            資格はこのインスタンスの承認作問者限定方式で使います。問題の審査は別に必要です。
          </p>
          {(page === 'qualification' || selectedId) && (
            <TextField
              id="author-reason"
              label="申請・資格変更の理由"
              placeholder="例：地理分野の問題を投稿したいです"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
          {page === 'qualification' && !data.qualified && (
            <Button
              disabled={busy}
              onClick={() => {
                void mutate({ operation: 'author-request', reason });
              }}
            >
              作問者資格を申請
            </Button>
          )}
          {data.authors
            .filter((author) =>
              page === 'qualification'
                ? author.actorId === data.actorId
                : !selectedId || author.actorId === selectedId,
            )
            .map((author) => (
              <div key={author.actorId} className="border border-line p-3">
                <p className="break-all">
                  {author.actorId === data.actorId ? '自分' : author.actorId}：
                  {{
                    pending: '申請中',
                    qualified: '資格あり',
                    rejected: '不承認',
                    revoked: '取消済み',
                  }[author.status] ?? author.status}
                </p>
                <p>{author.reason}</p>
                {page === 'authors' && !selectedId && (
                  <a
                    className="underline"
                    href={questionHref('authors', instanceId, author.actorId)}
                  >
                    この申請・資格を確認する
                  </a>
                )}
                {author.retryAt && (
                  <p>再申請可能日時：{new Date(author.retryAt).toLocaleString()}</p>
                )}
                {page === 'authors' &&
                  data.manageAuthors &&
                  selectedId === author.actorId && (
                    <div className="flex flex-wrap gap-3">
                      {(['qualified', 'rejected', 'revoked'] as const).map((decision) => (
                        <Button
                          key={decision}
                          disabled={busy}
                          onClick={() => {
                            void mutate({
                              operation: 'author-decision',
                              actorId: author.actorId,
                              revision: author.revision,
                              decision,
                              reason,
                            });
                          }}
                        >
                          {
                            {
                              qualified: '資格付与',
                              rejected: '不承認',
                              revoked: '資格取消',
                            }[decision]
                          }
                        </Button>
                      ))}
                    </div>
                  )}
              </div>
            ))}
          {page === 'authors' && data.manageAuthors && selectedId === 'new' && (
            <>
              <p>
                資格取消では公開中の問題は停止しません。承認作問者限定方式では、対象者の審査を終了して下書きを残します。
              </p>
              <TextField
                id="author-target"
                label="直接付与するアカウント識別子"
                placeholder="組織のアカウント一覧にある識別子"
                value={actor}
                onChange={(e) => setActor(e.target.value)}
              />
              <Button
                disabled={busy || !actor}
                onClick={() => {
                  void mutate({
                    operation: 'author-decision',
                    actorId: actor,
                    revision:
                      data.authors.find((a) => a.actorId === actor)?.revision ?? 0,
                    decision: 'qualified',
                    reason,
                  });
                }}
              >
                申請なしで資格を付与
              </Button>
            </>
          )}
          {page === 'authors' && !selectedId && (
            <a className="underline" href={questionHref('authors', instanceId, 'new')}>
              申請なしで資格を付与する
            </a>
          )}
        </section>
      )}
      {data.administrator && (
        <>
          {page === 'categories' && (
            <section className="grid gap-3 border border-line p-4">
              <h2 className="text-xl font-bold">カテゴリ管理</h2>
              {selectedId === 'new' && (
                <>
                  <TextField
                    id="category-name"
                    label="新しいカテゴリ名"
                    placeholder="例：地理"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  />
                  <Button
                    disabled={busy || !category.trim()}
                    onClick={async () => {
                      if (await mutate({ operation: 'category', name: category }))
                        setCategory('');
                    }}
                  >
                    カテゴリを追加
                  </Button>
                </>
              )}
              {data.categories
                .filter((c) => !selectedId || c.id === selectedId)
                .map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center gap-3">
                    <span>
                      {c.name}（{c.active ? '有効' : '廃止'}）
                    </span>
                    {!selectedId ? (
                      <a
                        className="underline"
                        href={questionHref('categories', instanceId, c.id)}
                      >
                        変更する
                      </a>
                    ) : (
                      <Button
                        disabled={
                          busy || (c.active && (!destination || destination === c.id))
                        }
                        onClick={() => {
                          void mutate({
                            operation: 'category',
                            id: c.id,
                            revision: c.revision,
                            name: c.name,
                            active: !c.active,
                            destination,
                          });
                        }}
                      >
                        {c.active ? '廃止する' : '有効にする'}
                      </Button>
                    )}
                  </div>
                ))}
              {selectedId && selectedId !== 'new' && (
                <label className="grid gap-2">
                  廃止時の移動先カテゴリ
                  <select
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                    className="border border-line p-3"
                  >
                    <option value="">選択してください</option>
                    {data.categories
                      .filter((item) => item.active)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {!selectedId && (
                <a
                  className="underline"
                  href={questionHref('categories', instanceId, 'new')}
                >
                  カテゴリを追加する
                </a>
              )}
            </section>
          )}
          {page === 'settings' && (
            <section className="grid gap-3 border border-line p-4">
              <h2 className="text-xl font-bold">投稿設定</h2>
              <label className="grid gap-2">
                投稿方式
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as SubmissionMode)}
                  className="border border-line p-3"
                >
                  <option value="admin">管理者限定</option>
                  <option value="qualified">承認作問者限定</option>
                  <option value="review">一般投稿・審査あり</option>
                  <option value="open">一般投稿・審査なし（非推奨）</option>
                </select>
              </label>
              <p>
                審査なしへの変更では、現在審査中の新規投稿・改訂も自動で出題可能になります。使用停止は維持します。
              </p>
              <TextField
                id="author-wait"
                type="number"
                min={0}
                max={3650}
                label="資格不承認後の再申請待機日数"
                placeholder="例：30"
                value={waitDays}
                onChange={(e) => setWaitDays(Number(e.target.value))}
              />
              <label>
                <Checkbox
                  checked={showAuthor}
                  onChange={(e) => setShowAuthor(e.target.checked)}
                />{' '}
                問題終了後に作問者名を表示
              </label>
              <Button
                disabled={busy}
                onClick={() => {
                  void mutate({
                    operation: 'settings',
                    revision: data.settingsRevision,
                    config: {
                      ...data.settings,
                      mode,
                      authorWaitDays: waitDays,
                      showAuthor,
                    },
                  });
                }}
              >
                投稿設定を保存
              </Button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
