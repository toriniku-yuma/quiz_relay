export type ParticipationTarget = {
  peerOrigin: string;
  sourceInstanceId: string;
  hostInstanceId: string;
  mode: 'ranked' | 'casual' | 'room';
};
export type ForeignSession = {
  reservationId: string;
  operationId: string;
  sourceInstanceId: string;
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
  sourceInstanceId: string;
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
  const flow = url.searchParams.get('flow');
  if (flow !== null && !['login', 'participation'].includes(flow)) return null;
  const keys = authorize
    ? ['host', 'source', 'instance', 'mode', 'state', 'operation']
    : ['home', 'source', 'instance', 'mode'];
  if (authorize && flow) keys.push('flow');
  if (
    [...url.searchParams.keys()].some((key) => !keys.includes(key)) ||
    keys.some((key) => url.searchParams.getAll(key).length !== 1) ||
    !participationOrigin(peer) ||
    !participationId(source) ||
    !participationId(instance) ||
    !['ranked', 'casual', 'room'].includes(mode ?? '') ||
    (authorize &&
      (!participationId(url.searchParams.get('state')) ||
        !participationId(url.searchParams.get('operation'))))
  )
    return null;
  return {
    peerOrigin: peer,
    sourceInstanceId: source,
    hostInstanceId: instance,
    mode: mode as ParticipationTarget['mode'],
  };
}

export function validParticipationMessage(
  value: unknown,
  state: string,
): value is {
  type: 'quiz-relay-participation';
  state: string;
  ticket: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return (
    Object.keys(message).sort().join(',') === 'state,ticket,type' &&
    message.type === 'quiz-relay-participation' &&
    message.state === state &&
    typeof message.ticket === 'string' &&
    message.ticket.length <= 16384
  );
}
