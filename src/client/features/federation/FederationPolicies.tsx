import { useState } from 'react';
import {
  disabledFederationPermissions,
  FEDERATION_FRESH_MS,
  type FederationPermissions,
} from '../../../shared/federation';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import { federationRequest, type useFederation } from './useFederation';

const labels = {
  ranked: 'ランク参加',
  casual: 'カジュアル・部屋参加',
  questions: '問題共有',
  results: '結果共有',
};
const federationCapabilities = ['questions', 'results'] as const;
type Preview = {
  results: {
    id: string;
    ok: boolean;
    before?: FederationPermissions;
    after?: FederationPermissions;
    code?: string;
  }[];
};
type PolicyChange = { id: string; revision: number; permissions: FederationPermissions };
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
  const [permissions, setPermissions] = useState(disabledFederationPermissions);
  const [fields, setFields] = useState<string[]>([]);
  const [preview, setPreview] = useState<(Preview & { items: PolicyChange[] }) | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const policies =
    federation.data?.policies.filter((row) => row.instanceId === instanceId) ?? [];
  const items = policies
    .filter((row) => selected.includes(row.id))
    .map((row) => {
      const changed = structuredClone(row.permissions);
      for (const direction of ['send', 'receive'] as const)
        for (const capability of federationCapabilities)
          if (fields.includes(`${direction}.${capability}`))
            changed[direction][capability] = permissions[direction][capability];
      return { id: row.id, revision: row.revision, permissions: changed };
    });
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
    <Panel title="インスタンスごとの共有許可">
      <p className="my-3">
        問題・結果の共有対象を選び、送出・受入を設定します。外部ユーザーの対戦参加は、組織の承認と参加制限で設定します。
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
            <p className="mt-2">
              送出：
              {federationCapabilities
                .filter((key) => policy.permissions.send[key])
                .map((key) => labels[key])
                .join('・') || 'すべてオフ'}
            </p>
            <p>
              受入：
              {federationCapabilities
                .filter((key) => policy.permissions.receive[key])
                .map((key) => labels[key])
                .join('・') || 'すべてオフ'}
            </p>
          </li>
        ))}
      </ul>
      <fieldset
        disabled={federation.busy || checking || !selected.length}
        className="grid gap-3"
      >
        <legend className="mb-3 font-bold">選択した対象への変更</legend>
        {(['send', 'receive'] as const).map((direction) => (
          <div key={direction} className="grid gap-2">
            <p className="font-bold">
              {direction === 'send'
                ? 'このインスタンスから送出'
                : 'このインスタンスへ受入'}
            </p>
            {federationCapabilities.map((capability) => (
              <div key={capability} className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={fields.includes(`${direction}.${capability}`)}
                    onChange={(event) => {
                      const field = `${direction}.${capability}`;
                      setFields((current) =>
                        event.target.checked
                          ? [...current, field]
                          : current.filter((value) => value !== field),
                      );
                      setPreview(null);
                    }}
                  />
                  {labels[capability]}を変更
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!fields.includes(`${direction}.${capability}`)}
                    checked={permissions[direction][capability]}
                    onChange={(event) => {
                      setPermissions((current) => ({
                        ...current,
                        [direction]: {
                          ...current[direction],
                          [capability]: event.target.checked,
                        },
                      }));
                      setPreview(null);
                    }}
                  />
                  許可する
                </label>
              </div>
            ))}
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
              {row.ok &&
                (['send', 'receive'] as const).map((direction) => (
                  <p key={direction}>
                    {direction === 'send' ? '送出' : '受入'}：
                    {federationCapabilities
                      .filter((key) => row.before?.[direction][key])
                      .map((key) => labels[key])
                      .join('・') || 'すべてオフ'}{' '}
                    →{' '}
                    {federationCapabilities
                      .filter((key) => row.after?.[direction][key])
                      .map((key) => labels[key])
                      .join('・') || 'すべてオフ'}
                  </p>
                ))}
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
