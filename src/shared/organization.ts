export const instancePermissions = ['questions', 'authors', 'users'] as const;
export type InstancePermission = (typeof instancePermissions)[number];

export type OrganizationOverview = {
  enabled: boolean;
  organization?: { id: string; name: string };
  setup?: { subject: string; eligible: boolean };
  account?: {
    actorId: string;
    administrator: boolean;
    displayName?: string | null;
    profileRevision?: number;
  };
  instances: {
    id: string;
    name: string;
    state: 'preparing' | 'published';
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
    (instance.state === 'published' || administrator || instance.permissions.length > 0)
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
