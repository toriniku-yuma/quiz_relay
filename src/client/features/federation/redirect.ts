import {
  type ParticipationTarget,
  participationId,
  participationOrigin,
} from '../../../shared/participation';
import { AUTHORIZE_PATH, CASUAL_PATH, GAME_PATH, ROOMS_PATH } from '../../app/paths';

const storageKey = 'quiz-relay-foreign-authorization';
type ForeignAuthorization = {
  target: ParticipationTarget;
  flow: 'login' | 'participation';
  state: string;
  operationId: string;
  startedAt: number;
};
export const foreignPlayPath = (mode: ParticipationTarget['mode']) =>
  mode === 'ranked' ? GAME_PATH : mode === 'casual' ? CASUAL_PATH : ROOMS_PATH;

export function readForeignAuthorization(
  storage: Pick<Storage, 'getItem'>,
): ForeignAuthorization | null {
  try {
    const value = JSON.parse(
      storage.getItem(storageKey) ?? 'null',
    ) as ForeignAuthorization | null;
    if (
      !value ||
      !['login', 'participation'].includes(value.flow) ||
      !participationId(value.state) ||
      !participationId(value.operationId) ||
      !Number.isSafeInteger(value.startedAt) ||
      value.startedAt > Date.now() ||
      value.startedAt < Date.now() - 600000 ||
      !participationOrigin(value.target?.peerOrigin) ||
      !participationId(value.target.sourceOrganizationId) ||
      !participationId(value.target.hostInstanceId) ||
      !['ranked', 'casual', 'room'].includes(value.target.mode)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function clearForeignAuthorization() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* No saved request remains usable. */
  }
}
export function beginForeignAuthorization(
  target: ParticipationTarget,
  flow: ForeignAuthorization['flow'],
  operationId: string = crypto.randomUUID(),
) {
  const request: ForeignAuthorization = {
    target,
    flow,
    operationId,
    state: crypto.randomUUID(),
    startedAt: Date.now(),
  };
  sessionStorage.setItem(storageKey, JSON.stringify(request));
  const url = new URL(AUTHORIZE_PATH, target.peerOrigin);
  url.search = new URLSearchParams({
    host: location.origin,
    source: target.sourceOrganizationId,
    instance: target.hostInstanceId,
    mode: target.mode,
    state: request.state,
    operation: operationId,
    flow,
  }).toString();
  location.replace(url.href);
}
export function foreignAuthorizationCallback(
  url: URL,
  pending: ForeignAuthorization | null,
) {
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (
    !pending ||
    [...fragment.keys()].sort().join(',') !== 'qr_state,qr_ticket' ||
    fragment.get('qr_state') !== pending.state ||
    fragment.getAll('qr_state').length !== 1 ||
    fragment.getAll('qr_ticket').length !== 1 ||
    url.pathname !== foreignPlayPath(pending.target.mode) ||
    url.searchParams.get('instance') !== pending.target.hostInstanceId
  )
    return null;
  const ticket = fragment.get('qr_ticket');
  return ticket && ticket.length <= 16384 ? { pending, ticket } : null;
}
export function foreignReturnUrl(
  target: ParticipationTarget,
  state: string,
  ticket: string,
) {
  const url = new URL(foreignPlayPath(target.mode), target.peerOrigin);
  url.search = new URLSearchParams({ instance: target.hostInstanceId }).toString();
  url.hash = new URLSearchParams({ qr_state: state, qr_ticket: ticket }).toString();
  return url.href;
}
