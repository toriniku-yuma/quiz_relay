import { API_PATHS } from '../../../shared/api-paths';
import {
  type ForeignAccount,
  type ForeignSession,
  participationId,
} from '../../../shared/participation';
import { PlayRequestError } from '../rooms/api';
import { beginForeignAuthorization } from './redirect';
import { foreignRequest } from './useForeignParticipation';

const storageKey = 'quiz-relay-foreign-room-entry';
type RoomEntry = {
  homeOrigin: string;
  sourceActorId: string;
  sourceOrganizationId: string;
  instanceId: string;
  operationId: string;
  action: 'create' | 'join';
  body: Record<string, unknown>;
  createdAt: number;
};
export function beginForeignRoomEntry(
  account: ForeignAccount,
  instanceId: string,
  action: 'create' | 'join',
  body: object,
) {
  const operationId = crypto.randomUUID(),
    value: RoomEntry = {
      homeOrigin: account.homeOrigin,
      sourceActorId: account.sourceActorId,
      sourceOrganizationId: account.organizationId,
      instanceId,
      operationId,
      action,
      body: body as Record<string, unknown>,
      createdAt: Date.now(),
    };
  const encoded = JSON.stringify(value);
  if (encoded.length > 2 * 1024 * 1024) throw new Error('部屋の設定が大きすぎます。');
  sessionStorage.setItem(storageKey, encoded);
  beginForeignAuthorization(
    {
      peerOrigin: account.homeOrigin,
      sourceOrganizationId: account.organizationId,
      hostInstanceId: instanceId,
      mode: 'room',
    },
    'participation',
    operationId,
  );
}
export function readForeignRoomEntry(session: ForeignSession) {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(storageKey) ?? 'null',
    ) as RoomEntry | null;
    if (
      !value ||
      !['create', 'join'].includes(value.action) ||
      !value.body ||
      typeof value.body !== 'object' ||
      Array.isArray(value.body) ||
      !participationId(value.body.room) ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt > Date.now() ||
      value.createdAt < Date.now() - 600000 ||
      value.homeOrigin !== session.homeOrigin ||
      value.sourceOrganizationId !== session.sourceOrganizationId ||
      value.sourceActorId !== session.sourceActorId ||
      value.instanceId !== session.instanceId ||
      value.operationId !== session.operationId
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function clearForeignRoomEntry() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* The live reservation remains server-authorized. */
  }
}
export async function restartForeignRoomEntry(
  session: ForeignSession,
  account: ForeignAccount,
  instanceId: string,
  action: 'create' | 'join',
  body: object,
) {
  try {
    await foreignRequest(
      API_PATHS.participationCancel,
      { forfeit: false },
      session.reservationId,
    );
  } catch (error) {
    if (!(error instanceof PlayRequestError) || error.code !== 'SESSION_REQUIRED')
      throw error;
  }
  clearForeignRoomEntry();
  beginForeignRoomEntry(account, instanceId, action, body);
}
