import { useState } from 'react';
import {
  FEDERATION_FRESH_MS,
  type QuestionSharingPolicy,
} from '../../../shared/federation';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import { federationRequest, type useFederation } from './useFederation';

const directions = [
  { field: 'sendQuestions', label: 'このインスタンスから問題を送出' },
  { field: 'receiveQuestions', label: 'このインスタンスへ問題を受入' },
] as const;
const sharingText = (sharing: QuestionSharingPolicy | undefined) =>
  [sharing?.sendQuestions ? '送出' : '', sharing?.receiveQuestions ? '受入' : '']
    .filter(Boolean)
    .join('・') || 'すべてオフ';
type Preview = {
  results: {
    id: string;
    ok: boolean;
    before?: QuestionSharingPolicy;
    after?: QuestionSharingPolicy;
    code?: string;
  }[];
};
type PolicyChange = QuestionSharingPolicy & { id: string; revision: number };
export default function FederationPolicies({
  instanceId,
  federation,
}: {
  instanceId: string;
  federation: ReturnType<typeof useFederation>;
}) {
  const [origin, setOrigin] = useState('');
  const [peerInstanceId, setPeerInstanceId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [sharing, setSharing] = useState<QuestionSharingPolicy>({
    sendQuestions: false,
    receiveQuestions: false,
  });
  const [fields, setFields] = useState<(keyof QuestionSharingPolicy)[]>([]);
  const [preview, setPreview] = useState<(Preview & { items: PolicyChange[] }) | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const policies =
    federation.data?.policies.filter((row) => row.instanceId === instanceId) ?? [];
  const items: PolicyChange[] = policies
    .filter((row) => selected.includes(row.id))
    .map((row) => ({
      id: row.id,
      revision: row.revision,
      sendQuestions: fields.includes('sendQuestions')
        ? sharing.sendQuestions
        : row.sendQuestions,
      receiveQuestions: fields.includes('receiveQuestions')
        ? sharing.receiveQuestions
        : row.receiveQuestions,
    }));
  const metadata = federation.data?.metadata.find(
    (row) => row.instanceId === instanceId && row.peerOrigin === origin,
  );
  const job = federation.data?.jobs.find(
    (row) => row.instanceId === instanceId && row.peerOrigin === origin,
  );
  const remoteInstances =
    !metadata?.errorCode &&
    (metadata?.lastSuccessAt ?? 0) >= Date.now() - FEDERATION_FRESH_MS
      ? (metadata?.payload.instances ?? [])
      : [];
  return (
    <Panel title="インスタンスごとの問題共有">
      <p className="my-3">
        問題共有の相手インスタンスを選び、送出・受入を設定します。外部ユーザーの対戦参加は、組織の承認と参加制限で設定します。
      </p>
      {job?.errorCode && (
        <p role="alert" className="my-3">
          相手の情報を取得できていません。{job.failures}回失敗しています。次の自動再試行：
          {new Date(job.nextAttemptAt).toLocaleString('ja-JP')}
          。下の再試行からも取得できます。
        </p>
      )}
      <form
        className="grid gap-3 border-b border-line pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          void federation
            .mutate({
              operation: 'policy',
              instanceId,
              peerOrigin: origin,
              peerInstanceId,
            })
            .then((saved) => {
              if (saved) setPeerInstanceId('');
            });
        }}
      >
        <label className="grid gap-2" htmlFor="policy-peer">
          接続先
          <select
            id="policy-peer"
            required
            disabled={federation.busy}
            className="h-12 border border-line bg-input p-2"
            value={origin}
            onChange={(event) => {
              const peerOrigin = event.target.value;
              setOrigin(peerOrigin);
              setPeerInstanceId('');
              if (peerOrigin)
                void federation.mutate({
                  operation: 'syncMetadata',
                  instanceId,
                  peerOrigin,
                });
            }}
          >
            <option value="">選択してください</option>
            {federation.data?.peers
              .filter((peer) => peer.approved)
              .map((peer) => (
                <option key={peer.origin} value={peer.origin}>
                  {peer.name}
                </option>
              ))}
          </select>
        </label>
        {federation.busy && origin && (
          <p role="status">相手のインスタンスを確認しています。</p>
        )}
        {metadata?.nextCursor && (
          <Button
            disabled={federation.busy}
            onClick={() => {
              void federation.mutate({
                operation: 'syncMetadata',
                instanceId,
                peerOrigin: origin,
                cursor: metadata.nextCursor,
              });
            }}
          >
            続きを取得
          </Button>
        )}
        {(metadata?.errorCode || job?.errorCode) && (
          <div className="grid gap-3">
            <p role="alert">相手の情報を取得できません。</p>
            <Button
              disabled={federation.busy}
              onClick={() => {
                void federation.mutate({
                  operation: 'syncMetadata',
                  instanceId,
                  peerOrigin: origin,
                });
              }}
            >
              再試行
            </Button>
          </div>
        )}
        <label htmlFor="peer-instance" className="grid gap-2">
          相手インスタンス
          <select
            id="peer-instance"
            required
            value={peerInstanceId}
            disabled={federation.busy || !remoteInstances.length}
            onChange={(event) => setPeerInstanceId(event.target.value)}
            className="h-12 border border-line bg-input p-2"
          >
            <option value="">選択してください</option>
            {remoteInstances.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="submit"
          disabled={
            federation.busy || !remoteInstances.some((row) => row.id === peerInstanceId)
          }
        >
          すべてオフで対象を追加
        </Button>
      </form>
      {!policies.length && <p className="my-4">連携対象はまだありません。</p>}
      <ul className="my-4 grid gap-3">
        {policies.map((policy) => (
          <li key={policy.id} className="border border-line p-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.includes(policy.id)}
                onChange={(event) => {
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, policy.id]
                      : current.filter((id) => id !== policy.id),
                  );
                  setPreview(null);
                }}
              />
              <span className="min-w-0 break-words">
                {
                  federation.data?.peers.find((peer) => peer.origin === policy.peerOrigin)
                    ?.name
                }
                <br />
                {federation.data?.metadata
                  .find(
                    (row) =>
                      row.instanceId === instanceId &&
                      row.peerOrigin === policy.peerOrigin,
                  )
                  ?.payload.instances.find((row) => row.id === policy.peerInstanceId)
                  ?.name ?? '相手インスタンス'}
              </span>
            </label>
            <p className="mt-2">問題共有：{sharingText(policy)}</p>
          </li>
        ))}
      </ul>
      <fieldset
        disabled={federation.busy || checking || !selected.length}
        className="grid gap-3"
      >
        <legend className="mb-3 font-bold">選択した対象への変更</legend>
        {directions.map(({ field, label }) => (
          <div key={field} className="grid gap-2">
            <p className="font-bold">{label}</p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={fields.includes(field)}
                  onChange={(event) => {
                    setFields((current) =>
                      event.target.checked
                        ? [...current, field]
                        : current.filter((value) => value !== field),
                    );
                    setPreview(null);
                  }}
                />
                変更する
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!fields.includes(field)}
                  checked={sharing[field]}
                  onChange={(event) => {
                    setSharing((current) => ({
                      ...current,
                      [field]: event.target.checked,
                    }));
                    setPreview(null);
                  }}
                />
                許可する
              </label>
            </div>
          </div>
        ))}
        <Button
          disabled={!fields.length || !items.length || items.length > 50}
          onClick={() => {
            setChecking(true);
            setError('');
            void federationRequest<Preview>({ operation: 'previewPolicies', items })
              .then((result) => setPreview({ ...result, items }))
              .catch((error) =>
                setError(error instanceof Error ? error.message : '確認できません。'),
              )
              .finally(() => setChecking(false));
          }}
        >
          変更内容を確認
        </Button>
      </fieldset>
      {error && (
        <p role="alert" className="my-3">
          {error}
        </p>
      )}
      {preview && (
        <div className="my-4 border border-line p-4">
          <h3 className="font-bold">保存前の確認</h3>
          {preview.results.map((row) => (
            <div className="my-3 break-words" key={row.id}>
              <p>
                {policies.find((policy) => policy.id === row.id)?.peerInstanceId}：
                {row.ok ? '更新可能' : '更新できません。一覧を再取得してください。'}
              </p>
              {row.ok && (
                <p>
                  問題共有：{sharingText(row.before)} → {sharingText(row.after)}
                </p>
              )}
            </div>
          ))}
          <Button
            tone="primary"
            disabled={federation.busy || !preview.results.every((row) => row.ok)}
            onClick={() => {
              void federation
                .mutate({ operation: 'policies', items: preview.items })
                .then((saved) => {
                  if (saved) {
                    setPreview(null);
                    setSelected([]);
                  }
                });
            }}
          >
            この内容で保存
          </Button>
        </div>
      )}
    </Panel>
  );
}
