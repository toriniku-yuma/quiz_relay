import { useState } from 'react';
import { externalInstanceHref, navigate } from '../../app/navigation';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import type { useExternalInstances } from './useExternalInstances';

export default function ExternalInstanceList({
  externalInstances,
}: {
  externalInstances?: ReturnType<typeof useExternalInstances>;
}) {
  const [peer, setPeer] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [showCatalog, setShowCatalog] = useState(false);
  if (!externalInstances) return null;
  const { data, error, busy, refresh, mutate, resolve, catalog } = externalInstances;
  const visibleInstances =
    data?.instances.filter(
      (row) => row.favorite || (showCatalog && row.peerOrigin === peer),
    ) ?? [];
  function syncPeer(origin: string) {
    if (origin) void mutate({ operation: 'syncMetadata', peerOrigin: origin });
  }
  return (
    <Panel title="外部インスタンス">
      <p className="my-3">
        お気に入りの参加先を開くか、開催先のインスタンスURLを入力してください。お気に入りの追加・解除だけでは対戦へ参加しません。
      </p>
      {error && (
        <p role="alert" className="my-3">
          {error}
        </p>
      )}
      {error && (
        <Button
          disabled={busy}
          onClick={() => {
            if (showCatalog && peer) syncPeer(peer);
            else void refresh();
          }}
        >
          再試行
        </Button>
      )}
      {data && (
        <form
          className="my-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void resolve(targetUrl).then((row) => {
              if (row) navigate(externalInstanceHref(row.peerOrigin, row.instanceId));
            });
          }}
        >
          <TextField
            id="external-url"
            label="参加先のインスタンスURL"
            type="url"
            required
            maxLength={2048}
            value={targetUrl}
            placeholder="https://server.example.workers.dev/game/?instance=…"
            onChange={(event) => setTargetUrl(event.target.value)}
          />
          <Button disabled={busy} type="submit">
            URLの参加先を開く
          </Button>
        </form>
      )}
      <h3 className="mt-5 font-bold">お気に入り</h3>
      {data && !data.instances.some((row) => row.favorite) && (
        <p className="my-3">お気に入りはまだありません。</p>
      )}
      <details
        className="my-4"
        onToggle={(event) => {
          setShowCatalog(event.currentTarget.open);
          void catalog(event.currentTarget.open);
        }}
      >
        <summary className="cursor-pointer underline">承認済みの接続先から探す</summary>
        {showCatalog && data && data.peers.length > 0 && (
          <div className="my-4 grid gap-3">
            <label htmlFor="external-peer" className="grid gap-2">
              接続先
              <select
                id="external-peer"
                disabled={busy}
                value={peer}
                onChange={(event) => {
                  const origin = event.target.value;
                  setPeer(origin);
                  syncPeer(origin);
                }}
                className="h-12 border border-line bg-input p-2"
              >
                <option value="">選択してください</option>
                {data.peers.map((row) => (
                  <option key={row.origin} value={row.origin}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </details>
      {busy && data && showCatalog && <p role="status">接続先を確認しています。</p>}
      {!data ? (
        <p role="status" className="my-3">
          外部インスタンスを確認しています。
        </p>
      ) : !visibleInstances.length ? (
        showCatalog &&
        peer &&
        !busy && <p className="my-3">利用可能な外部インスタンスはありません。</p>
      ) : (
        <ul className="my-4 grid gap-3">
          {visibleInstances.map((row) => (
            <li
              key={`${row.peerOrigin}:${row.instanceId}`}
              className="border border-line p-4"
            >
              <p>{row.organization}</p>
              <h3 className="font-bold">{row.name}</h3>
              <p className="break-words text-sm">{row.peerOrigin}</p>
              <p>
                {row.available
                  ? [row.ranked ? 'ランク' : '', row.casual ? 'カジュアル・部屋' : '']
                      .filter(Boolean)
                      .join('・')
                  : '現在は利用できません'}
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {(row.available || row.favorite) && (
                  <a
                    className="underline"
                    href={externalInstanceHref(row.peerOrigin, row.instanceId)}
                  >
                    {row.available ? 'このインスタンスを見る' : '情報を確認する'}
                  </a>
                )}
                <Button
                  disabled={busy}
                  onClick={() => {
                    void mutate({
                      operation: 'favorite',
                      peerOrigin: row.peerOrigin,
                      instanceId: row.instanceId,
                      added: !row.favorite,
                    });
                  }}
                >
                  {row.favorite ? 'お気に入りから外す' : 'お気に入りに追加'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
