import { useState } from 'react';
import type { FederationPeer } from '../../../shared/federation';
import Button from '../../components/Button';
import Panel from '../../components/Panel';
import TextField from '../../components/TextField';
import type { useFederation } from './useFederation';

const blank: FederationPeer = {
  origin: '',
  name: '',
  kid: '',
  publicKey: '',
  approved: false,
  participationBlocked: false,
  receiveRanked: true,
  receiveCasual: true,
  revision: 0,
};
export default function PeerSettings({
  federation,
}: {
  federation: ReturnType<typeof useFederation>;
}) {
  const [draft, setDraft] = useState<FederationPeer>(blank);
  const [origin, setOrigin] = useState('');
  return (
    <Panel title="相手組織の承認と参加制限">
      <p className="my-3">
        接続先URLで相手を確認し、この組織への参加を許可するか設定します。
      </p>
      <ul className="my-4 grid gap-2">
        {federation.data?.peers.map((peer) => (
          <li
            key={peer.origin}
            className="flex flex-wrap items-center gap-3 border border-line p-3"
          >
            <div className="min-w-0 flex-1 break-words">
              <strong>{peer.name}</strong>
              <p>{peer.origin}</p>
              <p>
                {peer.approved ? '承認済み' : '未承認'}
                {peer.participationBlocked ? '・参加禁止' : ''}
              </p>
              <p>
                参加許可：
                {[
                  peer.receiveRanked !== false ? 'ランク' : '',
                  peer.receiveCasual !== false ? 'カジュアル・部屋' : '',
                ]
                  .filter(Boolean)
                  .join('・') || 'なし'}
              </p>
            </div>
            <Button disabled={federation.busy} onClick={() => setDraft({ ...peer })}>
              編集
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="my-4 grid gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const peer = await federation.preparePeer(origin);
          if (peer)
            setDraft({
              origin: peer.origin,
              name: peer.name,
              kid: peer.kid,
              publicKey: peer.publicKey,
              revision: peer.revision,
              approved: peer.approved,
              participationBlocked: peer.participationBlocked,
              receiveRanked: peer.receiveRanked,
              receiveCasual: peer.receiveCasual,
            });
        }}
      >
        <TextField
          id="peer-url"
          label="接続先URL"
          type="url"
          required
          placeholder="https://server.example.workers.dev"
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
        />
        <Button type="submit" disabled={federation.busy}>
          相手を確認
        </Button>
      </form>
      {draft.publicKey && (
        <>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void federation.mutate({ operation: 'peer', ...draft }).then((saved) => {
                if (saved) setDraft(blank);
              });
            }}
          >
            <TextField
              id="peer-name"
              label="接続先の名前"
              maxLength={80}
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <p className="break-words">{draft.origin}</p>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={draft.approved}
                onChange={(event) =>
                  setDraft({ ...draft, approved: event.target.checked })
                }
              />
              この組織を承認する
            </label>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={draft.participationBlocked ?? false}
                onChange={(event) =>
                  setDraft({ ...draft, participationBlocked: event.target.checked })
                }
              />
              この組織との対戦参加を禁止する
            </label>
            <p className="text-sm">
              禁止は承認より優先し、相手のユーザーの受入と、所属ユーザーの相手への新規参加を止めます。承認を外すだけでは明示禁止になりません。
            </p>
            <fieldset className="grid gap-3">
              <legend className="mb-2 font-bold">この組織のユーザーに許可する対戦</legend>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={draft.receiveRanked ?? true}
                  onChange={(event) =>
                    setDraft({ ...draft, receiveRanked: event.target.checked })
                  }
                />
                ランク
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={draft.receiveCasual ?? true}
                  onChange={(event) =>
                    setDraft({ ...draft, receiveCasual: event.target.checked })
                  }
                />
                カジュアル・部屋
              </label>
            </fieldset>
            <div className="flex flex-wrap gap-3">
              <Button type="submit" tone="primary" disabled={federation.busy}>
                {draft.revision ? '変更を保存' : '接続先を登録'}
              </Button>
              <Button disabled={federation.busy} onClick={() => setDraft(blank)}>
                入力をリセット
              </Button>
            </div>
          </form>
          {draft.revision > 0 && (
            <details className="my-4">
              <summary>接続先の鍵が変更されたとき</summary>
              <div className="my-3 grid gap-3">
                <p>
                  相手の管理者に変更を確認してから、新しい鍵を取得・保存してください。
                </p>
                <Button
                  disabled={federation.busy}
                  onClick={async () => {
                    const peer = await federation.preparePeer(draft.origin, true);
                    if (peer)
                      setDraft({ ...draft, kid: peer.kid, publicKey: peer.publicKey });
                  }}
                >
                  新しい公開鍵を取得
                </Button>
              </div>
            </details>
          )}
        </>
      )}
    </Panel>
  );
}
