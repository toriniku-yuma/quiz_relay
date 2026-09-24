import {
  canAccessInstance,
  type InstancePermission,
  normalizeOrganizationName,
} from '../../shared/organization.ts';
import { contentHash } from '../catalog/hash.ts';
import type { Env } from '../env';

export class OrganizationError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 503;
  constructor(code: string, status: 400 | 403 | 404 | 409 | 503 = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export const actorForSubject = (namespace: string, subject: string) =>
  contentHash({ home: namespace, subject });
export function requireInstaller(subject: string, configured: string | undefined) {
  if (!configured || subject !== configured)
    throw new OrganizationError('SETUP_FORBIDDEN');
}
export function requireAdministrator(account: { administrator: boolean }) {
  if (!account.administrator) throw new OrganizationError('ADMIN_REQUIRED');
}
export function canViewInstance(
  state: string,
  administrator: boolean,
  permissions: readonly InstancePermission[],
) {
  return canAccessInstance({ state, permissions }, administrator);
}
export function validName(value: unknown): string {
  const name = normalizeOrganizationName(value);
  if (name === undefined) throw new OrganizationError('INVALID_NAME', 400);
  return name;
}
export function validId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    throw new OrganizationError('INVALID_INSTANCE', 400);
  return value;
}

export function organizationEnabled(env: Env) {
  if (env.ORGANIZATION_ENABLED === 'true') return true;
  if (env.ORGANIZATION_ENABLED === 'false') return false;
  if (
    env.ORGANIZATION_ENABLED !== undefined ||
    env.ORGANIZATION_DATABASE_URL ||
    env.ORGANIZATION_HYPERDRIVE
  )
    throw new OrganizationError('ORGANIZATION_CONFIG_INVALID', 503);
  return false;
}
