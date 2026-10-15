import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { ModeratedUser } from '../../../shared/moderation';
import { useApp } from '../../app/context';
import Button from '../../components/Button';
import Modal from '../../components/Modal';
import TextField from '../../components/TextField';
import Investigation from './Investigation';
import UserScopeSelect from './UserScopeSelect';
import { useMutation } from './useMutation';
import { useUserActions } from './useUserActions';
export default function UserCases({
  user,
  instanceId,
  kind,
  saved,
}: {
  user: ModeratedUser;
  instanceId: string | null;
  kind: 'reports' | 'appeals';
  saved: () => Promise<void>;
}) {
  const model = useUserActions(instanceId, user.actorId, saved);
  const { organization } = useApp();
  const administrator = organization.data?.account?.administrator === true;
  const scopes =
    organization.data?.instances.filter(
      (instance) => administrator || instance.permissions.includes('users'),
    ) ?? [];
  const [selected, setSelected] = useState<string[]>([]),
    [reason, setReason] = useState(''),
    [decision, setDecision] = useState(''),
    [reportId, setReportId] = useState('');
  const mutation = useMutation(API_PATHS.moderationWorkflow, async () => {
    setSelected([]);
    setReason('');
    await model.refresh();
  });
  const count = kind === 'reports' ? user.reportCount : user.appealCount;
  const rows = kind === 'reports' ? model.data?.reports : model.data?.appeals;
  return (
    <>
      <button
        type="button"
        className="min-h-11 underline"
        aria-label={`${user.name}の${kind === 'reports' ? '未対応通報' : '異議申し立て'}：${count ?? 0}件`}
        onClick={() => void model.show(kind)}
      >
        {count ?? 0}件
      </button>
      {model.open && (
        <Modal
          title={`${user.name}：${kind === 'reports' ? '通報' : '異議申し立て'}`}
          busy={mutation.busy}
          onClose={() => model.setOpen('')}
        >
          <UserScopeSelect
            value={model.scope}
            instances={scopes}
            allowOrganization={administrator}
            organizationLabel="組織全体の記録"
            disabled={model.busy || mutation.busy || mutation.uncertain}
            onChange={(value) => {
              setSelected([]);
              setReportId('');
              setReason('');
              setDecision('');
              void model.changeScope(value);
            }}
          />
          {(model.error || mutation.error) && (
            <Button
              disabled={model.busy || mutation.busy || mutation.uncertain}
              onClick={model.load}
            >
              最新の内容を取得
            </Button>
          )}
          {model.error && <p role="alert">{model.error}</p>}
          {model.busy && <p role="status">読み込んでいます。</p>}
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void mutation.submit({
                action: kind === 'reports' ? 'resolveReports' : 'decideAppeal',
                instanceId: model.scope,
                actorId: user.actorId,
                ids: selected,
                id: selected[0],
                sanctionRevision: model.data?.appeals?.find(
                  (appeal) => appeal.id === selected[0],
                )?.sanction.revision,
                reason,
                decision,
              });
            }}
          >
            <fieldset
              disabled={
                model.busy || !!model.error || mutation.busy || mutation.uncertain
              }
              className="grid gap-3"
            >
              {rows?.map((row) => (
                <div key={row.id} className="border border-line p-3">
                  <label>
                    <input
                      type={kind === 'reports' ? 'checkbox' : 'radio'}
                      name="case"
                      disabled={!!row.resolvedAt}
                      checked={selected.includes(row.id)}
                      onChange={(event) =>
                        setSelected(
                          kind === 'appeals'
                            ? [row.id]
                            : event.target.checked
                              ? [...selected, row.id]
                              : selected.filter((id) => id !== row.id),
                        )
                      }
                    />{' '}
                    {new Date(row.createdAt).toLocaleString()} /{' '}
                    {row.resolvedAt ? '対応済み' : '未対応'}
                  </label>
                  <p className="whitespace-pre-wrap">{row.reason}</p>
                  {row.resolution && <p>対応理由：{row.resolution}</p>}
                  {'sanction' in row && (
                    <p>
                      対象BAN：
                      {row.sanction.instanceId === null
                        ? '組織全体'
                        : (scopes.find((scope) => scope.id === row.sanction.instanceId)
                            ?.name ?? '削除済みインスタンス')}{' '}
                      / {row.sanction.reason}
                    </p>
                  )}
                  {'matchId' in row && (
                    <div className="grid gap-2">
                      <p>
                        {scopes.find((scope) => scope.id === row.instanceId)?.name ??
                          'インスタンス'}
                      </p>
                      <Button onClick={() => setReportId(row.id)}>
                        試合と過去戦績を確認
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {!rows?.length && <p>該当する記録はありません。</p>}
              {kind === 'appeals' && (
                <label className="grid gap-2">
                  対応
                  <select
                    required
                    value={decision}
                    onChange={(event) => setDecision(event.target.value)}
                    className="h-12 border border-line p-3"
                  >
                    <option value="">選択してください</option>
                    <option value="revoke">BANを取り消す</option>
                    <option value="maintain">BANを維持する</option>
                  </select>
                </label>
              )}
              <TextField
                id={`case-reason-${kind}`}
                label="対応理由"
                placeholder="例：調査の結果、違反を確認できなかったため"
                required
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </fieldset>
            {mutation.error && <p role="alert">{mutation.error}</p>}
            {mutation.uncertain && (
              <p>保存結果が不明のため、同じ内容で再試行してください。</p>
            )}
            <Button
              type="submit"
              disabled={
                mutation.busy ||
                model.busy ||
                !!model.error ||
                (!mutation.uncertain && !selected.length)
              }
            >
              {mutation.uncertain
                ? '同じ内容で再試行'
                : kind === 'reports'
                  ? '選択した通報を対応済みにする'
                  : '対応を送信'}
            </Button>
          </form>
          {reportId && (
            <Investigation
              instanceId={
                model.data?.reports?.find((report) => report.id === reportId)
                  ?.instanceId ?? model.scope
              }
              actorId={user.actorId}
              reportId={reportId}
            />
          )}
        </Modal>
      )}
    </>
  );
}
