import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import {
  type InstancePermission,
  permissionRevision,
} from '../../../shared/organization';
import { organizationRequest, type useOrganization } from './useOrganization';

export function useInstanceGrants(
  instanceId: string,
  organization: ReturnType<typeof useOrganization>,
) {
  const [actorId, setActorId] = useState('');
  const [verified, setVerified] = useState('');
  const [permissions, setPermissions] = useState<InstancePermission[]>([]);
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function lookup() {
    setBusy(true);
    setError('');
    setVerified('');
    try {
      const data = await organizationRequest(API_PATHS.organizationPermissions, {
        id: instanceId,
        actorId,
      });
      const target = data.accounts?.[0];
      if (!target || target.actorId !== actorId || target.administrator)
        throw new Error('対象を確認できません。管理者はすべての担当権限を持っています。');
      const current = data.grants?.map((g) => g.permission) ?? [];
      setPermissions(current);
      setExpected(permissionRevision(current));
      setVerified(actorId);
    } catch (error) {
      setError(error instanceof Error ? error.message : '確認できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return {
    actorId,
    verified,
    permissions,
    setPermissions,
    error,
    busy: busy || organization.busy,
    changeActor: (value: string) => {
      setActorId(value.trim());
      setVerified('');
      setError('');
    },
    lookup,
    save: () =>
      organization.mutate(API_PATHS.organizationGrants, {
        id: instanceId,
        actorId: verified,
        permissions,
        expected,
      }),
  };
}
