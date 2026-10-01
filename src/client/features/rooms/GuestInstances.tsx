import { useCallback, useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { CasualSettings } from '../../../shared/rooms';
import { CASUAL_PATH, ROOMS_PATH } from '../../app/paths';
import Button from '../../components/Button';
import DataTable from '../../components/DataTable';
import Panel from '../../components/Panel';
import { playRequest } from './api';
export default function GuestInstances() {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : '一覧を読み込めませんでした。');
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <Panel title="ゲストで遊べるインスタンス">
      <p className="my-3">参加できるインスタンスを選んでください。</p>
      {error && <p role="alert">{error}</p>}
      <Button onClick={refresh}>一覧を更新</Button>
      <DataTable label="ゲスト参加可能なインスタンス" columns={['名前', '受付', '参加']}>
        {instances?.map((i) => (
          <tr key={i.id}>
            <td>{i.name}</td>
            <td>{i.casualPauseReason ? `停止中：${i.casualPauseReason}` : '受付中'}</td>
            <td>
              <div className="flex gap-4">
                {i.casualConfig.enabled && i.casualConfig.casualGuests && (
                  <a
                    className="underline"
                    href={`${CASUAL_PATH}?instance=${i.id}&guest=1`}
                  >
                    カジュアル
                  </a>
                )}
                {i.casualConfig.roomGuests && (
                  <a
                    className="underline"
                    href={`${ROOMS_PATH}?instance=${i.id}&guest=1`}
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
        <p>現在、ゲストを受け入れているインスタンスはありません。</p>
      )}
    </Panel>
  );
}
