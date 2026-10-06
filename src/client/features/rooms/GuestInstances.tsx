import { useCallback, useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { CasualSettings } from '../../../shared/rooms';
import { navigate } from '../../app/navigation';
import { CASUAL_PATH, ROOMS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import DataTable from '../../components/DataTable';
import Panel from '../../components/Panel';
import { playRequest } from './api';
export default function GuestInstances({ instanceId = '' }: { instanceId?: string }) {
  const [instances, setInstances] = useState<
      | {
          id: string;
          name: string;
          casualConfig: CasualSettings;
          casualPauseReason: string | null;
        }[]
      | null
    >(null),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setInstances(
        (
          await playRequest<{ instances: NonNullable<typeof instances> }>(
            API_PATHS.guestInstances,
          )
        ).instances,
      );
      setError('');
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : '一覧を読み込めませんでした。',
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selected = instances?.find((instance) => instance.id === instanceId);
  if (instanceId)
    return (
      <Panel title={selected?.name ?? 'インスタンス'}>
        <div className="mt-4 grid gap-4">
          {!instances ? (
            <p role="status">参加設定を確認しています。</p>
          ) : !selected ? (
            <p>このインスタンスではゲスト参加を受け付けていません。</p>
          ) : (
            <>
              {selected.casualPauseReason && <p>停止中：{selected.casualPauseReason}</p>}
              <div className="flex flex-wrap gap-3">
                {selected.casualConfig.enabled && selected.casualConfig.casualGuests && (
                  <Button
                    tone="primary"
                    onClick={() =>
                      navigate(`${CASUAL_PATH}?instance=${selected.id}&guest=1`)
                    }
                  >
                    カジュアルマッチ
                  </Button>
                )}
                {selected.casualConfig.roomGuests && (
                  <Button
                    tone="primary"
                    onClick={() =>
                      navigate(`${ROOMS_PATH}?instance=${selected.id}&guest=1`)
                    }
                  >
                    部屋
                  </Button>
                )}
              </div>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <Button onClick={refresh}>参加設定を更新</Button>
        </div>
      </Panel>
    );
  return (
    <Panel title="ゲストで遊べるインスタンス">
      <p className="my-3">参加できるインスタンスを選んでください。</p>
      {error && <p role="alert">{error}</p>}
      <Button className="mb-4" onClick={refresh}>
        一覧を更新
      </Button>
      <DataTable label="ゲスト参加可能なインスタンス" columns={['名前', '受付', '参加']}>
        {instances?.map((instance) => (
          <tr key={instance.id}>
            <td>{instance.name}</td>
            <td>
              {instance.casualPauseReason
                ? `停止中：${instance.casualPauseReason}`
                : '受付中'}
            </td>
            <td>
              <div className="flex gap-4">
                {instance.casualConfig.enabled && instance.casualConfig.casualGuests && (
                  <a
                    className="underline"
                    href={`${CASUAL_PATH}?instance=${instance.id}&guest=1`}
                  >
                    カジュアルマッチ
                  </a>
                )}
                {instance.casualConfig.roomGuests && (
                  <a
                    className="underline"
                    href={`${ROOMS_PATH}?instance=${instance.id}&guest=1`}
                  >
                    部屋
                  </a>
                )}
              </div>
            </td>
          </tr>
        ))}
      </DataTable>
      {instances?.length === 0 && (
        <p className="mt-4">現在、ゲストを受け入れているインスタンスはありません。</p>
      )}
    </Panel>
  );
}
