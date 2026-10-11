import type { QuestionSharingOverview } from '../../../shared/federation-questions';
import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import TextField from '../../components/TextField';
import { useQuestionImportForm } from './useQuestionImportForm';
import type { useQuestionSharing } from './useQuestionSharing';

export default function QuestionImportForm({
  sharing,
  initial,
  onSaved,
  onCancel,
}: {
  sharing: ReturnType<typeof useQuestionSharing>;
  initial?: QuestionSharingOverview['imports'][number];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const model = useQuestionImportForm(sharing, initial, onSaved);
  return (
    <form
      className="my-4 grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void model.save();
      }}
    >
      <fieldset disabled={sharing.busy} className="grid gap-4">
        <legend className="mb-3 font-bold">
          {initial ? '受け取る範囲と保存先を変更' : '受け取り元を追加'}
        </legend>
        {initial ? (
          <p>共有元：{model.source?.name ?? initial.peerOrigin}</p>
        ) : (
          <label className="grid gap-2" htmlFor="shared-source">
            共有元
            <select
              id="shared-source"
              required
              value={model.sourceKey}
              className="h-12 border border-line bg-input p-2"
              onChange={(event) => {
                model.setSourceKey(event.target.value);
                model.setSelectedCategories([]);
                model.setRange('');
              }}
            >
              <option value="">選択してください</option>
              {sharing.data?.sources.map((source) => (
                <option
                  key={`${source.peerOrigin}|${source.instanceId}`}
                  value={`${source.peerOrigin}|${source.instanceId}`}
                >
                  {source.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {model.source?.internal && sharing.data?.administrator && model.catalogFailed && (
          <Button
            onClick={() =>
              void sharing.mutate({
                operation: 'internalPermission',
                sourceInstanceId: model.sourceInstanceId,
                allowed: true,
              })
            }
          >
            このインスタンスからの受け取りを許可
          </Button>
        )}
        {model.sourceKey && (
          <>
            {model.catalogFailed && (
              <p role="status">
                共有元のカテゴリを取得できません。組織設定で問題の送信・受信の許可を確認してください。
              </p>
            )}
            {model.catalog && !model.catalog.ready && (
              <p role="status">
                {model.catalog.errorCode
                  ? '共有元に接続できません。時間をおいて自動で再確認します。'
                  : '共有元のカテゴリを取得しています。'}
              </p>
            )}
            <fieldset className="grid gap-3">
              <legend className="mb-3 font-bold">受け取る問題</legend>
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  name="shared-range"
                  checked={model.range === 'all'}
                  onChange={() => model.setRange('all')}
                />
                インスタンスの全カテゴリ（今後追加されるカテゴリも含む）
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  name="shared-range"
                  checked={model.range === 'selected'}
                  onChange={() => model.setRange('selected')}
                />
                カテゴリを選ぶ
              </label>
              {model.range === 'selected' && (
                <div className="grid gap-3 border border-line p-3">
                  {model.catalog?.ready && !model.catalog.categories.length && (
                    <p>共有元にカテゴリがありません。</p>
                  )}
                  {(model.catalog?.categories ?? []).map((category) => (
                    <label key={category.id} className="flex items-center gap-3">
                      <Checkbox
                        checked={model.selectedCategories.includes(category.id)}
                        onChange={(event) =>
                          model.setSelectedCategories(
                            event.target.checked
                              ? [...model.selectedCategories, category.id]
                              : model.selectedCategories.filter(
                                  (id) => id !== category.id,
                                ),
                          )
                        }
                      />
                      {category.name}
                    </label>
                  ))}
                  {model.selectedCategories
                    .filter(
                      (id) =>
                        !model.catalog?.categories.some((category) => category.id === id),
                    )
                    .map((id) => (
                      <label key={id} className="flex items-center gap-3">
                        <Checkbox
                          checked
                          onChange={() =>
                            model.setSelectedCategories(
                              model.selectedCategories.filter((value) => value !== id),
                            )
                          }
                        />
                        {sharing.data?.sourceCategories.find(
                          (category) =>
                            category.id === id &&
                            category.sourceInstanceId === initial?.sourceInstanceId &&
                            category.peerOrigin === initial?.peerOrigin,
                        )?.name ?? '保存済みのカテゴリ'}
                        （現在は取得できません）
                      </label>
                    ))}
                </div>
              )}
            </fieldset>
            <label className="grid gap-2" htmlFor="shared-destination">
              保存先カテゴリ
              <select
                id="shared-destination"
                required
                value={model.destination}
                className="h-12 border border-line bg-input p-2"
                onChange={(event) => model.setDestination(event.target.value)}
              >
                <option value="">選択してください</option>
                {sharing.data?.categories.map((category) => (
                  <option value={category.id} key={category.id}>
                    {category.name}
                    {category.importOnly ? '（取り込み専用）' : ''}
                  </option>
                ))}
                {sharing.data?.administrator && (
                  <>
                    <option value="new-import-only">取り込み専用カテゴリを作成</option>
                    <option value="new-normal">通常のカテゴリを作成</option>
                  </>
                )}
              </select>
            </label>
            {model.destination.startsWith('new-') && (
              <TextField
                id="shared-new-category"
                label="新しいカテゴリ名"
                placeholder="例：外部の一般問題"
                required
                maxLength={80}
                value={model.newCategoryName}
                onChange={(event) => model.setNewCategoryName(event.target.value)}
              />
            )}
            {model.destination === 'new-import-only' && (
              <p className="text-sm">
                受け取った問題を保存するカテゴリです。このインスタンスでは作問できません。
              </p>
            )}
            <label className="flex items-center gap-3">
              <Checkbox
                checked={model.enabled}
                onChange={(event) => model.setEnabled(event.target.checked)}
              />
              この共有元の問題を利用する
            </label>
          </>
        )}
        <div className="flex flex-wrap gap-3">
          <Button tone="primary" type="submit" disabled={!model.ready}>
            保存
          </Button>
          <Button onClick={onCancel}>キャンセル</Button>
        </div>
      </fieldset>
    </form>
  );
}
