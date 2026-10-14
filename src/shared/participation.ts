export type ParticipationTarget = {
  peerOrigin: string;
  sourceOrganizationId: string;
  hostInstanceId: string;
  mode: 'ranked' | 'casual' | 'room';
};
export type ForeignSession = {
  reservationId: string;
  operationId: string;
  sourceOrganizationId: string;
  actorId: string;
  sourceActorId?: string;
  name: string;
  instanceId: string;
  instanceName: string;
  homeOrigin: string;
  mode: 'ranked' | 'casual' | 'room';
  room: string;
  expiresAt: number;
};
export type ForeignAccount = {
  homeOrigin: string;
  organizationId: string;
  organizationName: string;
  sourceActorId: string;
  name: string;
  expiresAt: number;
};
export type ForeignLoginOverview = {
  account: ForeignAccount;
  organizationName: string;
  instances: {
    id: string;
    name: string;
    ranked: boolean;
    casual: boolean;
    room: boolean;
  }[];
};
export type ForeignLoginTicket = {
  protocolVersion: 1;
  iss: string;
  aud: string;
  sub: string;
  sourceOrganizationId: string;
  hostInstanceId: string;
  mode: ParticipationTarget['mode'];
  name: string;
  organizationName: string;
  state: string;
  jti: string;
  iat: number;
  exp: number;
};
export const FOREIGN_LOGIN_LIFETIME = 43200000;
export function participationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}
export function participationOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === 'https:' &&
      !url.port &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev$/.test(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}
export function participationTarget(
  url: URL,
  authorize = false,
): ParticipationTarget | null {
  const peer = url.searchParams.get(authorize ? 'host' : 'home'),
    source = url.searchParams.get('source'),
    instance = url.searchParams.get('instance'),
    mode = url.searchParams.get('mode');
  const keys = authorize
    ? ['host', 'source', 'instance', 'mode', 'state', 'operation', 'flow']
    : ['home', 'source', 'instance', 'mode'];
  if (
    [...url.searchParams.keys()].some((key) => !keys.includes(key)) ||
    keys.some((key) => url.searchParams.getAll(key).length !== 1) ||
    !participationOrigin(peer) ||
    !participationId(source) ||
    !participationId(instance) ||
    !['ranked', 'casual', 'room'].includes(mode ?? '') ||
    (authorize &&
      (!participationId(url.searchParams.get('state')) ||
        !participationId(url.searchParams.get('operation')) ||
        !['login', 'participation'].includes(url.searchParams.get('flow') ?? '')))
  )
    return null;
  return {
    peerOrigin: peer,
    sourceOrganizationId: source,
    hostInstanceId: instance,
    mode: mode as ParticipationTarget['mode'],
  };
}
