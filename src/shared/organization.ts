import { blocks, type Sanction } from './moderation.ts';

export const instancePermissions = ['questions', 'authors', 'users'] as const;
export type InstancePermission = (typeof instancePermissions)[number];

export type OrganizationOverview = {
  organization?: { id: string; name: string };
  setup?: { subject: string; eligible: boolean };
  account?: {
    actorId: string;
    administrator: boolean;
    displayName?: string | null;
    profileRevision?: number;
  };
  addedInstanceIds?: string[];
  sanctions?: Sanction[];
  instances: {
    id: string;
    name: string;
    state: 'preparing' | 'published' | 'archived';
    operationRevision?: number;
    pauseReason?: string | null;
    rankedPauseReason?: string | null;
    casualPauseReason?: string | null;
    casualConfig?: import('./rooms.ts').CasualSettings;
    rankedPlayers?: number;
    hasOwnQuestions?: boolean;
    permissions: InstancePermission[];
  }[];
  grants?: { instanceId: string; actorId: string; permission: InstancePermission }[];
  nextAccountCursor?: string;
  accounts?: { actorId: string; administrator: boolean }[];
};

export function canAccessInstance(
  instance: { state: string; permissions: readonly InstancePermission[] } | undefined,
  administrator = false,
) {
  return (
    !!instance &&
    instance.state !== 'archived' &&
    (instance.state === 'published' || administrator || instance.permissions.length > 0)
  );
}

export function canJoinInstance(
  instance: OrganizationOverview['instances'][number] | undefined,
  account: OrganizationOverview['account'],
  sanctions: readonly Sanction[] | undefined,
  mode: 'ranked' | 'casual' | 'room' | 'roomCreate',
) {
  if (
    !instance ||
    !account?.displayName ||
    !sanctions ||
    !canAccessInstance(instance, account.administrator)
  )
    return false;
  const privileged = account.administrator || instance.permissions.length > 0;
  if (
    (!privileged &&
      (mode === 'ranked' ? instance.rankedPauseReason : instance.casualPauseReason)) ||
    (mode === 'casual' && instance.casualConfig?.enabled === false)
  )
    return false;
  return !sanctions.some(
    (row) =>
      (row.instanceId === null || row.instanceId === instance.id) &&
      (blocks(row, mode === 'ranked' ? 'ranked' : 'casual') ||
        (mode === 'roomCreate' && blocks(row, 'rooms'))),
  );
}

export const permissionRevision = (permissions: readonly InstancePermission[]) =>
  [...permissions].sort().join(',');

export function normalizeOrganizationName(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.replace(/\p{Cf}/gu, '').trim() ||
    value.trim().length > 80 ||
    /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
    return undefined;
  return value.trim();
}
