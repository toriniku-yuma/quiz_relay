import { useCallback, useEffect, useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { ExternalInstanceDirectory } from '../../../shared/federation';
import { organizationRequest } from '../organization/useOrganization';

export function useExternalInstances(actorId: string | undefined) {
  const activeActor = useRef(actorId);
  const inFlight = useRef(new Set<string>());
  activeActor.current = actorId;
  const [snapshot, setSnapshot] = useState<{
    actorId: string;
    data: ExternalInstanceDirectory;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const catalogVisible = useRef(false);
  const [opened, setOpened] = useState<{
    actorId: string;
    instance: ExternalInstanceDirectory['instances'][number];
  } | null>(null);
  const refresh = useCallback(async () => {
    if (!actorId || inFlight.current.has(actorId)) return;
    inFlight.current.add(actorId);
    setBusy(true);
    setError('');
    try {
      const received = await organizationRequest<ExternalInstanceDirectory>(
        API_PATHS.federationDirectory,
        { operation: catalogVisible.current ? 'catalog' : 'overview' },
      );
      if (activeActor.current === actorId) {
        setSnapshot({ actorId, data: received });
        setOpened((previous) =>
          previous
            ? {
                ...previous,
                instance: {
                  ...(received.instances.find(
                    (row) =>
                      row.peerOrigin === previous.instance.peerOrigin &&
                      row.instanceId === previous.instance.instanceId,
                  ) ?? previous.instance),
                  favorite: received.instances.some(
                    (row) =>
                      row.favorite &&
                      row.peerOrigin === previous.instance.peerOrigin &&
                      row.instanceId === previous.instance.instanceId,
                  ),
                },
              }
            : null,
        );
      }
    } catch (error) {
      if (activeActor.current === actorId)
        setError(
          error instanceof Error ? error.message : '外部インスタンスを取得できません。',
        );
    } finally {
      inFlight.current.delete(actorId);
      if (activeActor.current === actorId) setBusy(false);
    }
  }, [actorId]);
  useEffect(() => {
    setSnapshot(null);
    setOpened(null);
    catalogVisible.current = false;
    setError('');
    setBusy(false);
    if (actorId) void refresh();
    let lastRefresh = Date.now();
    const updated = () => {
      if (
        !actorId ||
        document.visibilityState !== 'visible' ||
        Date.now() - lastRefresh < 10000
      )
        return;
      lastRefresh = Date.now();
      void refresh();
    };
    const timer = setInterval(updated, 60000);
    window.addEventListener('focus', updated);
    document.addEventListener('visibilitychange', updated);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', updated);
      document.removeEventListener('visibilitychange', updated);
    };
  }, [actorId, refresh]);
  const resolve = useCallback(
    async (url: string) => {
      if (!actorId || inFlight.current.has(actorId)) return null;
      inFlight.current.add(actorId);
      setBusy(true);
      setError('');
      try {
        const received = await organizationRequest<{
          instance?: ExternalInstanceDirectory['instances'][number];
        }>(API_PATHS.federationDirectory, {
          operation: 'resolve',
          url,
        });
        if (activeActor.current !== actorId) return null;
        if (!received.instance)
          throw new Error('この組織から参加できる対戦はありません。');
        setOpened({ actorId, instance: received.instance });
        return received.instance;
      } catch (error) {
        if (activeActor.current === actorId) {
          setOpened(null);
          setError(error instanceof Error ? error.message : '参加先を確認できません。');
        }
        return null;
      } finally {
        inFlight.current.delete(actorId);
        if (activeActor.current === actorId) setBusy(false);
      }
    },
    [actorId],
  );
  async function catalog(visible = true) {
    catalogVisible.current = visible;
    if (!visible) return;
    if (!actorId || inFlight.current.has(actorId)) return;
    inFlight.current.add(actorId);
    setBusy(true);
    setError('');
    try {
      const received = await organizationRequest<ExternalInstanceDirectory>(
        API_PATHS.federationDirectory,
        { operation: 'catalog' },
      );
      if (activeActor.current === actorId) {
        setSnapshot({ actorId, data: received });
      }
    } catch (error) {
      if (activeActor.current === actorId)
        setError(error instanceof Error ? error.message : '一覧を取得できません。');
    } finally {
      inFlight.current.delete(actorId);
      if (activeActor.current === actorId) setBusy(false);
    }
  }
  async function mutate(body: object) {
    if (!actorId || inFlight.current.has(actorId)) return false;
    inFlight.current.add(actorId);
    setBusy(true);
    setError('');
    try {
      await organizationRequest(API_PATHS.federationDirectory, body);
      if (activeActor.current !== actorId) return false;
      inFlight.current.delete(actorId);
      await refresh();
      return true;
    } catch (error) {
      if (activeActor.current === actorId)
        setError(error instanceof Error ? error.message : '操作できません。');
      return false;
    } finally {
      inFlight.current.delete(actorId);
      if (activeActor.current === actorId) setBusy(false);
    }
  }
  return {
    data: snapshot && snapshot.actorId === actorId ? snapshot.data : null,
    busy,
    error,
    opened: opened && opened.actorId === actorId ? opened.instance : null,
    resolve,
    catalog,
    refresh,
    mutate,
  };
}
