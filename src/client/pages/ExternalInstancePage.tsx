import { useEffect, useRef } from 'react';
import { useApp } from '../app/context';
import Button from '../components/Button';
import ExternalParticipationLinks from '../features/federation/ExternalParticipationLinks';

export default function ExternalInstancePage() {
  const { url, externalInstances, organization } = useApp();
  const actorId = organization.data?.account?.actorId;
  const requested = useRef('');
  const peerOrigin = url.searchParams.get('peer') ?? '',
    instanceId = url.searchParams.get('instance') ?? '';
  const targetUrl = `${peerOrigin}/game/?instance=${encodeURIComponent(instanceId)}`;
  const resolve = externalInstances?.resolve,
    busy = externalInstances?.busy,
    ready = !!externalInstances?.data;
  useEffect(() => {
    const key = `${actorId}:${targetUrl}`;
    if (!actorId || !ready || !resolve || busy || requested.current === key) return;
    requested.current = key;
    void resolve(targetUrl);
  }, [actorId, ready, targetUrl, resolve, busy]);
  const opened = externalInstances?.opened;
  const row =
    opened?.peerOrigin === peerOrigin && opened.instanceId === instanceId
      ? opened
      : externalInstances?.data?.instances.find(
          (instance) =>
            instance.peerOrigin === url.searchParams.get('peer') &&
            instance.instanceId === url.searchParams.get('instance'),
        );
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 tabIndex={-1} className="mb-4 text-3xl font-bold outline-none">
        外部インスタンス
      </h1>
      {externalInstances?.error && <p role="alert">{externalInstances.error}</p>}
      {externalInstances?.error && (
        <div className="my-4 grid gap-3">
          <Button
            disabled={busy}
            onClick={() => {
              void resolve?.(targetUrl);
            }}
          >
            再試行
          </Button>
        </div>
      )}
      {row ? (
        <>
          <h2 className="text-xl font-bold">{row.name}</h2>
          <p>{row.organization}</p>
          <p className="break-words">{row.peerOrigin}</p>
          <p className="my-4">
            {row.available
              ? 'このインスタンスへ参加できます。'
              : '現在は利用できません。情報の更新と連携許可を確認してください。'}
          </p>
          {row.available &&
            !busy &&
            !externalInstances?.error &&
            opened?.peerOrigin === peerOrigin &&
            opened.instanceId === instanceId && (
              <ExternalParticipationLinks
                key={`${row.peerOrigin}:${row.instanceId}`}
                instance={row}
                organizationId={externalInstances?.data?.organizationId ?? ''}
              />
            )}
          <Button
            disabled={
              externalInstances?.busy || (!row.favorite && !!externalInstances?.error)
            }
            onClick={() => {
              void externalInstances?.mutate({
                operation: 'favorite',
                peerOrigin: row.peerOrigin,
                instanceId: row.instanceId,
                added: !row.favorite,
              });
            }}
          >
            {row.favorite ? 'お気に入りから外す' : 'お気に入りに追加'}
          </Button>
        </>
      ) : (
        <p>利用可能な外部インスタンスを一覧から選んでください。</p>
      )}
    </main>
  );
}
