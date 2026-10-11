import type { InstancePermission } from './organization.ts';
import type { Pagination } from './pagination.ts';
import type { ResultsOverview } from './results.ts';

export const restrictionLabels = {
  ranked: 'ランク',
  casual: 'カジュアル',
  rooms: '部屋作成',
  submit: '問題提出・再提出',
} as const;
export type Restriction = keyof typeof restrictionLabels;
export type SanctionKind = 'timeout' | 'ban' | 'partial';
export const sanctionLabels = {
  timeout: 'タイムアウト',
  ban: 'BAN',
  partial: '部分制限',
} as const;
export type Sanction = {
  id: string;
  instanceId: string | null;
  actorId: string;
  kind: SanctionKind;
  restrictions: Restriction[];
  reason: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revision: number;
};
export type ModeratedUser = {
  actorId: string;
  name: string;
  origin: string;
  administrator: boolean;
  permissions?: InstancePermission[];
  sanctions?: Sanction[];
  reportCount?: number;
  appealCount?: number;
};
export type ModerationEvent = {
  id: string;
  actorId: string;
  operatorId: string;
  instanceId: string | null;
  action: 'add' | 'change' | 'revoke' | 'inspect';
  reason: string;
  before: Sanction | null;
  after: Sanction | null;
  createdAt: string;
};
export type ModerationOverview = {
  scopeName: string;
  administrator?: boolean;
  pagination?: Pagination;
  eventsPagination?: Pagination;
  eventsBefore?: string;
  reports?: UserReport[];
  appeals?: Appeal[];
  transfers?: Transfer[];
  operatorNames?: Record<string, string>;
  users: ModeratedUser[];
  next: string | null;
  target?: ModeratedUser;
  sanctions: Sanction[];
  events: ModerationEvent[];
  canModerate: boolean;
  history?: (ResultsOverview['history'][number] & { instanceName: string })[];
};
export function activeSanction(row: Sanction, now = Date.now()) {
  return !row.revokedAt && (!row.expiresAt || Date.parse(row.expiresAt) > now);
}
export function blocks(row: Sanction, action: Restriction, now = Date.now()) {
  return (
    activeSanction(row, now) &&
    (row.kind !== 'partial' || row.restrictions.includes(action))
  );
}
export function parseSanction(
  input: Record<string, unknown>,
  organizationWide: boolean,
  now = Date.now(),
) {
  const kind = input.kind as SanctionKind;
  if (!Object.hasOwn(sanctionLabels, kind) || (organizationWide && kind !== 'ban'))
    throw new Error('INVALID_SANCTION');
  const restrictions = input.restrictions;
  if (
    !Array.isArray(restrictions) ||
    restrictions.length > 4 ||
    new Set(restrictions).size !== restrictions.length ||
    restrictions.some((value) => !Object.hasOwn(restrictionLabels, value)) ||
    (kind === 'partial' ? !restrictions.length : restrictions.length !== 0)
  )
    throw new Error('INVALID_SANCTION');
  let expiresAt: string | null = null;
  if (kind === 'timeout') {
    const end = typeof input.expiresAt === 'string' ? Date.parse(input.expiresAt) : NaN;
    // Preserve the displayed end while allowing time to read the confirmation dialog.
    const prepared = typeof input.preparedAt === 'number' ? input.preparedAt : now;
    if (
      !Number.isFinite(prepared) ||
      prepared < now - 300000 ||
      prepared > now + 1000 ||
      !Number.isFinite(end) ||
      end <= now ||
      end < prepared + 60_000 ||
      end > prepared + 30 * 86400_000
    )
      throw new Error('INVALID_TIMEOUT');
    expiresAt = new Date(end).toISOString();
  } else if (input.expiresAt !== null) throw new Error('INVALID_SANCTION');
  return { kind, restrictions: restrictions as Restriction[], expiresAt };
}

export type UserReport = {
  id: string;
  instanceId?: string;
  actorId: string;
  reporterId: string;
  reporterName: string;
  resultId: string;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
};
export type Appeal = {
  id: string;
  actorId: string;
  sanctionId: string;
  sanctionRevision: number;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  decision: 'revoke' | 'maintain' | null;
  sanction: Sanction;
};
export type Transfer = {
  id: string;
  senderId: string;
  targetId: string;
  senderName: string;
  targetName: string;
  state: 'pending' | 'accepted' | 'cancelled';
  expiresAt: string;
  keepSender: boolean;
};

export type PersonalModeration = {
  sanctions: Sanction[];
  appeals: Omit<Appeal, 'sanction'>[];
  transfers: Transfer[];
};

export function sanctionRevision(rows: Sanction[]) {
  return rows
    .filter((sanction) => activeSanction(sanction))
    .map((sanction) => `${sanction.id}:${sanction.revision}`)
    .sort()
    .join('|');
}
