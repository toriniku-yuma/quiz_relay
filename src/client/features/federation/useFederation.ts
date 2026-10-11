import { useCallback, useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { FederationOverview } from '../../../shared/federation';
import { organizationRequest } from '../organization/useOrganization';

export const federationRequest = <T>(body: object) =>
  organizationRequest<T>(API_PATHS.federationManage, body);
export function useFederation(enabled: boolean) {
  const [data, setData] = useState<FederationOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setData(await federationRequest<FederationOverview>({ operation: 'overview' }));
    } catch (error) {
      setError(error instanceof Error ? error.message : '連携設定を取得できません。');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  async function mutate(body: object) {
    setBusy(true);
    setError('');
    try {
      await federationRequest(body);
      await refresh();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存できません。');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function preparePeer(origin: string, rotate = false) {
    setBusy(true);
    setError('');
    try {
      return await federationRequest<import('../../../shared/federation').FederationPeer>(
        { operation: 'preparePeer', origin, rotate },
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '接続先を確認できません。');
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { data, error, busy, refresh, mutate, preparePeer };
}
