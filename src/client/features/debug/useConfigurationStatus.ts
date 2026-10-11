import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { OrganizationOverview } from '../../../shared/organization';
import { setupAuth } from '../auth/client';
import { organizationRequest } from '../organization/useOrganization';

export type ConfigurationStatus = {
  name: string;
  organization: OrganizationOverview;
} | null;

export async function loadConfigurationStatus(): Promise<ConfigurationStatus> {
  const client = await setupAuth();
  const session = await client.auth.getSession();
  if (session.error) throw new Error('ログイン状態を確認できませんでした。');
  if (!session.data.session) return null;
  const { data, error } = await client.auth.getUser();
  if (error || !data.user)
    throw new Error('本人確認に失敗しました。ログインし直してください。');
  const organization = await organizationRequest(API_PATHS.organizationOverview);
  return {
    name: organization.account?.displayName?.trim() || 'ログイン済み',
    organization,
  };
}

export function useConfigurationStatus() {
  const [data, setData] = useState<ConfigurationStatus>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setData(null);
    setBusy(true);
    setError('');
    try {
      const result = await loadConfigurationStatus();
      if (request === generation.current) setData(result);
    } catch (error) {
      if (request === generation.current)
        setError(error instanceof Error ? error.message : '設定を確認できませんでした。');
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void setupAuth()
      .then((client) => {
        if (!active) return;
        const subscription = client.auth.onAuthStateChange(() => {
          // Clear the previous identity immediately; defer async Auth calls outside its callback lock.
          generation.current++;
          setData(null);
          setBusy(true);
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (active) void refresh();
          }, 0);
        });
        unsubscribe = () => subscription.data.subscription.unsubscribe();
        void refresh();
      })
      .catch(() => {
        if (active) {
          setError('認証設定を取得できませんでした。');
          setBusy(false);
        }
      });
    return () => {
      active = false;
      generation.current++;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [refresh]);
  return { data, busy, error, refresh };
}
