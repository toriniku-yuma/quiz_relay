import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { OrganizationOverview } from '../../../shared/organization';
import { defaultCasualSettings } from '../../../shared/rooms';
import Button from '../../components/Button';
import Checkbox from '../../components/Checkbox';
import TextField from '../../components/TextField';
import { useMutation } from '../moderation/useMutation';
import { playRequest } from './api';
export default function CasualSettings({
  instance,
  refresh,
}: {
  instance: OrganizationOverview['instances'][number];
  refresh: () => Promise<boolean>;
}) {
  const [config, setConfig] = useState(instance.casualConfig ?? defaultCasualSettings);
  const [revision, setRevision] = useState(instance.operationRevision);
  const [rankedPlayers, setRankedPlayers] = useState(instance.rankedPlayers ?? 4);
  const mutation = useMutation(
    API_PATHS.casualSettings,
    async (request) => {
      setRevision(Number(request.revision) + 1);
      if (!(await refresh())) throw new Error('REFRESH_FAILED');
    },
    (path, body) => playRequest(path, body, instance.id),
  );
  const locked = mutation.busy || mutation.uncertain;
  return (
    <form
      className="my-5 grid gap-3 border-y border-line py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.submit({
          id: instance.id,
          config,
          rankedPlayers,
          revision,
        });
      }}
    >
      <h4 className="font-bold">対戦の参加設定</h4>
      <fieldset className="grid gap-3" disabled={locked}>
        <TextField
          id={`ranked-players-${instance.id}`}
          label="ランクマッチの人数（2〜4人）"
          placeholder="例：4"
          type="number"
          min={2}
          max={4}
          value={rankedPlayers}
          onChange={(event) => setRankedPlayers(event.target.valueAsNumber)}
        />
        <p>
          人数の変更は新しい待機に適用します。変更前からの待機は取り消して、参加し直してください。
        </p>
        <label className="flex gap-3">
          <Checkbox
            checked={config.enabled}
            onChange={(event) => setConfig({ ...config, enabled: event.target.checked })}
          />
          カジュアルマッチを有効にする
        </label>
        <TextField
          id={`casual-players-${instance.id}`}
          label="カジュアルマッチの人数（2〜4人）"
          placeholder="例：4"
          type="number"
          min={2}
          max={4}
          value={config.players}
          onChange={(event) =>
            setConfig({ ...config, players: event.target.valueAsNumber })
          }
        />
        <label className="flex gap-3">
          <Checkbox
            checked={config.casualGuests}
            onChange={(event) =>
              setConfig({ ...config, casualGuests: event.target.checked })
            }
          />
          カジュアルマッチへのゲスト参加を許可
        </label>
        <label className="flex gap-3">
          <Checkbox
            checked={config.roomGuests}
            onChange={(event) =>
              setConfig({ ...config, roomGuests: event.target.checked })
            }
          />
          部屋へのゲスト参加を許可
        </label>
        <p>
          ゲスト参加は初期状態で禁止です。許可しても、作問資格や新しい部屋の作成権限は付与しません。
        </p>
      </fieldset>
      {mutation.error && <p role="alert">{mutation.error}</p>}
      {mutation.uncertain && <p>保存結果が不明です。同じ内容で再試行してください。</p>}
      <Button type="submit" disabled={mutation.busy}>
        {mutation.uncertain ? '同じ内容で再試行' : '参加設定を保存'}
      </Button>
    </form>
  );
}
