import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { ModerationOverview } from '../../../shared/moderation';
import { organizationRequest } from '../organization/useOrganization';
export function useUserActions(
  instanceId: string | null,
  actorId: string,
  saved: () => Promise<void>,
) {
  const [open, setOpen] = useState(''),
    [data, setData] = useState<ModerationOverview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError('');
    try {
      setData(
        await organizationRequest<ModerationOverview>(API_PATHS.moderationUsers, {
          instanceId,
          actorId,
        }),
      );
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得できませんでした。');
      return false;
    } finally {
      setBusy(false);
    }
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
  return { open, setOpen, data, error, busy, show, refresh, load };
}
