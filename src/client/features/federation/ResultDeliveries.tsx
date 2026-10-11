import Button from '../../components/Button';
import Panel from '../../components/Panel';
import type { useFederation } from './useFederation';

export default function ResultDeliveries({
  instanceId,
  federation,
}: {
  instanceId: string;
  federation: ReturnType<typeof useFederation>;
}) {
  const jobs = [
    ...(
      federation.data?.deliveries?.filter((job) => job.instanceId === instanceId) ?? []
    ).map((job) => ({ ...job, control: false })),
    ...(federation.data?.controls ?? []).map((job) => ({ ...job, control: true })),
  ];
  return (
    <Panel title="結果・利用停止通知の配送">
      <p className="my-3">
        直近50件の配送状態です。通信失敗は自動で再試行します。隔離された結果は原因を確認してから再送してください。保存済みの結果を上書きする操作ではありません。
      </p>
      {!jobs.length && <p>配送対象はありません。</p>}
      <ul className="my-4 grid gap-4">
        {jobs.map((job) => (
          <li
            key={`${job.peerOrigin}:${job.eventId}`}
            className="grid gap-3 border border-line p-4"
          >
            <p>{job.control ? '退会・削除の通知' : '対戦結果'}</p>
            <p className="break-words">{job.peerOrigin}</p>
            <p>
              {job.appliedAt
                ? '反映済み'
                : job.receivedAt
                  ? '受信済み'
                  : job.quarantined
                    ? '隔離中'
                    : '未配送'}{' '}
              ／ 試行 {job.attempts}回
            </p>
            {job.errorCode && (
              <p role="status">
                {job.errorCode} ／ 次の試行：
                {new Date(job.nextAttemptAt).toLocaleString('ja-JP')}
              </p>
            )}
            {!(job.control ? job.appliedAt : job.receivedAt) && (
              <Button
                disabled={federation.busy}
                onClick={() =>
                  void federation.mutate(
                    job.control
                      ? {
                          operation: 'retryControl',
                          eventId: job.eventId,
                          peerOrigin: job.peerOrigin,
                        }
                      : { operation: 'retryResult', eventId: job.eventId },
                  )
                }
              >
                同じ通知を再送
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
