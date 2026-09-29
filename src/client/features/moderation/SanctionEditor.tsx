import { useRef } from 'react';
import type {
  ModeratedUser,
  ModerationOverview,
  Restriction,
  SanctionKind,
} from '../../../shared/moderation';
import { restrictionLabels, sanctionLabels } from '../../../shared/moderation';
import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import Modal from '../../components/Modal';
import TextField from '../../components/TextField';
import { useActiveSanctions } from './useActiveSanctions';
import { useSanctionEditor } from './useModeration';
export default function SanctionEditor({
  data,
  loadError = '',
  loading = false,
  reload,
  instanceId,
  saved,
  open,
  onClose,
  batch,
}: {
  data: ModerationOverview;
  batch?: ModeratedUser[];
  loadError?: string;
  loading?: boolean;
  reload?: () => Promise<boolean>;
  instanceId: string | null;
  saved: () => Promise<void>;
  open: boolean;
  onClose: () => void;
}) {
  const model = useSanctionEditor(instanceId, data.target?.actorId ?? '', saved, batch);
  const frozen = useRef(batch);
  if (!model.uncertain) frozen.current = batch;
  batch = frozen.current;
  const active = useActiveSanctions(data.sanctions);
  if (!open) return null;
  return (
    <Modal
      title={batch ? `一括処分：${batch.length}人` : `処分の設定：${data.target?.name}`}
      onClose={onClose}
      busy={model.busy}
    >
      {loadError && (
        <div>
          <p role="alert">保存後の最新情報を取得できませんでした。{loadError}</p>
          <Button
            disabled={loading || model.busy}
            onClick={async () => {
              if (await reload?.()) model.clearError();
            }}
          >
            再試行
          </Button>
        </div>
      )}
      {loading && <p role="status">最新の内容を取得しています。</p>}
      {!data.canModerate ? (
        <p>自分自身、または権限上保護されているユーザーには処分できません。</p>
      ) : (
        <div className="grid gap-5">
          {batch && (
            <p>
              選択中 {batch.length}人：{batch.map((u) => u.name).join('、')}
            </p>
          )}
          <div className="grid gap-3">
            {batch && (
              <Button
                disabled={model.busy || model.uncertain}
                onClick={() => model.edit(null, true)}
              >
                処分の一括取消
              </Button>
            )}
            {active.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center gap-3 border border-line p-3"
              >
                <p>
                  {row.instanceId === null ? '組織全体' : 'このインスタンス'}：
                  {sanctionLabels[row.kind]} /{' '}
                  {row.expiresAt ? new Date(row.expiresAt).toLocaleString() : '期限なし'}{' '}
                  / {row.reason}
                </p>
                <Button
                  disabled={model.busy || model.uncertain || loading || !!loadError}
                  onClick={() => model.edit(row)}
                >
                  変更
                </Button>
                <Button
                  disabled={model.busy || model.uncertain || loading || !!loadError}
                  onClick={() => model.edit(row, true)}
                >
                  処分を取り消す
                </Button>
              </div>
            ))}
            <Button
              disabled={model.busy || model.uncertain || loading || !!loadError}
              onClick={() => model.edit(null)}
            >
              新しい処分
            </Button>
          </div>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              model.preview(true);
            }}
          >
            <fieldset
              disabled={model.busy || model.uncertain || loading || !!loadError}
              className="grid gap-4"
            >
              <label className="grid gap-2">
                処分の種類
                <select
                  className="h-12 border border-line bg-paper p-3"
                  required
                  value={model.kind}
                  disabled={model.revoke && !batch}
                  onChange={(e) => model.setKind(e.target.value as SanctionKind)}
                >
                  <option value="">選択してください</option>
                  {Object.entries(sanctionLabels)
                    .filter(
                      ([kind]) =>
                        (model.before?.instanceId !== null &&
                          model.before?.kind !== 'ban') ||
                        kind === 'ban',
                    )
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                </select>
              </label>
              {model.kind === 'ban' && (
                <label>
                  <Checkbox
                    checked={model.organizationWide}
                    disabled={!!model.before}
                    onChange={(e) => model.setOrganizationWide(e.target.checked)}
                  />{' '}
                  組織全体に適用
                </label>
              )}
              {model.kind === 'partial' && !model.revoke && (
                <fieldset className="grid gap-2">
                  <legend>制限対象</legend>
                  {Object.entries(restrictionLabels).map(([k, v]) => (
                    <label key={k}>
                      <Checkbox
                        checked={model.restrictions.includes(k as Restriction)}
                        onChange={(e) =>
                          model.setRestrictions(
                            e.target.checked
                              ? [...model.restrictions, k as Restriction]
                              : model.restrictions.filter((r) => r !== k),
                          )
                        }
                      />{' '}
                      {v}
                    </label>
                  ))}
                </fieldset>
              )}
              {model.kind === 'timeout' && !model.revoke && (
                <>
                  <label className="grid gap-2">
                    期限の指定方法
                    <select
                      required
                      className="h-12 border border-line bg-paper p-3"
                      value={model.timing}
                      onChange={(e) => model.setTiming(e.target.value)}
                    >
                      <option value="">選択してください</option>
                      <option value="duration">期間から指定</option>
                      <option value="date">終了日時</option>
                    </select>
                  </label>
                  {model.timing === 'duration' && (
                    <div className="flex items-end gap-3">
                      <TextField
                        id="sanction-duration"
                        label="期間"
                        type="number"
                        placeholder="例：10"
                        min="1"
                        required
                        value={model.duration}
                        onChange={(e) => model.setDuration(e.target.value)}
                      />
                      <label className="grid gap-2">
                        単位
                        <select
                          required
                          className="h-12 border border-line bg-paper p-3"
                          value={model.unit}
                          onChange={(e) => model.setUnit(e.target.value)}
                        >
                          <option value="">選択</option>
                          <option value="1">分</option>
                          <option value="60">時間</option>
                          <option value="1440">日</option>
                        </select>
                      </label>
                    </div>
                  )}
                  {model.timing === 'date' && (
                    <TextField
                      id="sanction-end"
                      label="終了日時（この端末の時刻）"
                      type="datetime-local"
                      required
                      value={model.end}
                      onChange={(e) => model.setEnd(e.target.value)}
                    />
                  )}
                  <p>1分〜30日以内で指定してください。</p>
                </>
              )}
              <TextField
                id="sanction-reason"
                label={model.revoke ? '取消理由' : '理由'}
                placeholder="例：利用ルール違反のため"
                required
                maxLength={1000}
                value={model.reason}
                onChange={(e) => model.setReason(e.target.value)}
              />
            </fieldset>
            <p>
              {model.revoke
                ? '選んだ処分を取り消します。BANの取り消しではランキングにも復帰します。'
                : '開始済みの試合と過去の戦績は維持します。BAN中は適用範囲のランキングから除外されます。'}
            </p>
            {model.message && <p role="status">{model.message}</p>}
            {model.error && <p role="alert">{model.error}</p>}
            {model.uncertain && !model.busy && (
              <p role="status">
                保存結果を確認できないため編集を一時停止しています。同じ内容で再試行してください。
              </p>
            )}
            <Button
              type="submit"
              disabled={model.busy || loading || !!loadError}
              tone="primary"
            >
              {model.busy
                ? '保存中…'
                : model.uncertain
                  ? '同じ内容で再試行'
                  : model.revoke
                    ? '処分を取り消す'
                    : '処分を保存'}
            </Button>
          </form>
        </div>
      )}
    </Modal>
  );
}
