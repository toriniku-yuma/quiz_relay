import { restrictionLabels, sanctionLabels } from '../../../shared/moderation';
import { useApp } from '../../app/context';
import ReasonAction from './ReasonAction';
import TransferInvitation from './TransferInvitation';
import { usePersonalModeration } from './usePersonalModeration';
export default function PersonalRestrictions() {
  const { organization } = useApp();
  const model = usePersonalModeration();
  return (
    <section className="mt-8">
      <h2 className="text-xl font-bold">現在の利用制限</h2>
      {model.error && <p role="alert">{model.error}</p>}
      {model.loading && <p role="status">利用制限を読み込んでいます。</p>}
      {!model.loading && !model.error && !model.rows.length && (
        <p>有効な制限はありません。</p>
      )}
      <ul>
        {model.rows.map((row) => (
          <li key={row.id} className="my-3 border border-line p-3">
            <p>
              {row.instanceId
                ? (organization.data?.instances.find((item) => item.id === row.instanceId)
                    ?.name ?? '利用先のインスタンス')
                : '組織全体'}
              ：{sanctionLabels[row.kind]}
            </p>
            <p>
              {row.kind === 'partial'
                ? row.restrictions.map((key) => restrictionLabels[key]).join('・')
                : '新規対戦・部屋作成・問題提出／再提出'}
            </p>
            <p>
              期限：
              {row.expiresAt
                ? new Date(row.expiresAt).toLocaleString()
                : '運営による解除まで'}
            </p>
            <p className="whitespace-pre-wrap">理由：{row.reason}</p>
            {row.kind === 'ban' && (
              <ReasonAction
                title="異議を申し立てる"
                input={{ action: 'appeal', id: row.id }}
                disabled={model.details?.appeals.some(
                  (a) => a.sanctionId === row.id && !a.resolvedAt,
                )}
              />
            )}
          </li>
        ))}
      </ul>
      <h3 className="mt-6 font-bold">異議申し立ての履歴</h3>
      {model.details?.appeals.map((a) => (
        <div key={a.id} className="my-3 border border-line p-3">
          <p>
            {new Date(a.createdAt).toLocaleString()} /{' '}
            {a.resolvedAt
              ? a.decision === 'revoke'
                ? 'BANを取り消しました'
                : 'BANを維持しました'
              : '対応待ち'}
          </p>
          <p className="whitespace-pre-wrap">申立理由：{a.reason}</p>
          {a.resolution && (
            <p className="whitespace-pre-wrap">対応理由：{a.resolution}</p>
          )}
        </div>
      ))}
      <h3 className="mt-6 font-bold">管理者引き継ぎ</h3>
      {model.details?.transfers.map((invite) => (
        <TransferInvitation key={invite.id} invite={invite} />
      ))}
    </section>
  );
}
