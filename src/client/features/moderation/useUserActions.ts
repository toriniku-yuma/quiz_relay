import { useRef, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { ModerationOverview } from '../../../shared/moderation';
import { organizationRequest } from '../organization/useOrganization';
export function useUserActions(
  instanceId: string | null,
  actorId: string,
  saved: () => Promise<void>,
) {
  const [open, setOpen] = useState(''),
    [selection, setSelection] = useState({ initial: instanceId, value: instanceId }),
    [loaded, setData] = useState<{
      actorId: string;
      instanceId: string | null;
      value: ModerationOverview;
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const scope = selection.initial === instanceId ? selection.value : instanceId;
  const identity = JSON.stringify([scope, actorId]);
  const current = useRef(identity);
  current.current = identity;
  const version = useRef(0);
  const data =
    loaded?.actorId === actorId && loaded.instanceId === scope ? loaded.value : null;
  async function fetchScope(requestScope: string | null) {
    const request = ++version.current;
    const requested = JSON.stringify([requestScope, actorId]);
    setBusy(true);
    setError('');
    try {
      const value = await organizationRequest<ModerationOverview>(
        API_PATHS.moderationUsers,
        {
          instanceId: requestScope,
          actorId,
        },
      );
      if (request !== version.current || requested !== current.current) return false;
      setData({ actorId, instanceId: requestScope, value });
      return true;
    } catch (caughtError) {
      if (request !== version.current || requested !== current.current) return false;
      setError(
        caughtError instanceof Error ? caughtError.message : '取得できませんでした。',
      );
      return false;
    } finally {
      if (request === version.current) setBusy(false);
    }
  }
  const load = () => fetchScope(scope);
  async function changeScope(value: string | null) {
    setSelection({ initial: instanceId, value });
    current.current = JSON.stringify([value, actorId]);
    setData(null);
    await fetchScope(value);
  }
  async function show(kind: string) {
    setOpen(kind);
    if (!data || error) await load();
  }
  async function refresh() {
    const loaded = await load();
    await saved();
    if (!loaded) throw new Error('詳細を取得できませんでした。');
  }
  return { open, setOpen, data, error, busy, show, refresh, load, scope, changeScope };
}
