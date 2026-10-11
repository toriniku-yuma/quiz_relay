import { eq } from 'drizzle-orm';
import {
  base64url,
  CompactSign,
  compactVerify,
  decodeProtectedHeader,
  importPKCS8,
  importSPKI,
} from 'jose';
import type { ForeignLoginTicket } from '../../shared/participation.ts';
import { normalizeDisplayName } from '../../shared/profile.ts';
import { federationPeers } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError, validId, validName } from '../organization/access.ts';
import {
  CLOCK_SKEW,
  canonical,
  DELIVERY_TTL,
  origin,
  parseCanonical,
} from './signatures.ts';
import { federationDatabase } from './transport.ts';

export type ParticipationTicket = {
  protocolVersion: 1;
  iss: string;
  sub: string;
  aud: string;
  sourceInstanceId: string;
  hostInstanceId: string;
  mode: 'ranked' | 'casual' | 'room';
  matchId: string;
  reservationId: string;
  authorizationId: string;
  jti: string;
  iat: number;
  exp: number;
};
const type = 'quiz-relay-participation+jws',
  encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
function claims(value: unknown): ParticipationTicket {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SCHEMA');
  const ticket = value as ParticipationTicket;
  if (
    Object.keys(ticket).sort().join(',') !==
      'aud,authorizationId,exp,hostInstanceId,iat,iss,jti,matchId,mode,protocolVersion,reservationId,sourceInstanceId,sub' ||
    ticket.protocolVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(ticket.sub) ||
    !['ranked', 'casual', 'room'].includes(ticket.mode)
  )
    throw new Error('SCHEMA');
  origin(ticket.iss);
  origin(ticket.aud);
  for (const id of [
    ticket.sourceInstanceId,
    ticket.hostInstanceId,
    ticket.matchId,
    ticket.reservationId,
    ticket.authorizationId,
    ticket.jti,
  ])
    validId(id);
  if (
    !Number.isSafeInteger(ticket.iat) ||
    !Number.isSafeInteger(ticket.exp) ||
    ticket.exp <= ticket.iat ||
    ticket.exp - ticket.iat > DELIVERY_TTL
  )
    throw new Error('TIME');
  return ticket;
}
export async function signParticipationTicket(env: Env, ticket: ParticipationTicket) {
  federationDatabase(env);
  claims(ticket);
  return new CompactSign(encoder.encode(canonical(ticket)))
    .setProtectedHeader(
      JSON.parse(canonical({ alg: 'EdDSA', kid: env.SIGNING_KID, typ: type })),
    )
    .sign(await importPKCS8(env.SIGNING_PRIVATE_KEY ?? '', 'EdDSA'));
}
type TicketIdentity = { iss: string; aud: string; iat: number; exp: number };
async function verifyTicket<T extends TicketIdentity>(
  env: Env,
  message: unknown,
  expectedType: string,
  parse: (value: unknown) => T,
) {
  try {
    if (typeof message !== 'string' || encoder.encode(message).byteLength > 16384)
      throw new Error('SIZE');
    const segments = message.split('.');
    if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error('STRUCTURE');
    parseCanonical(decoder.decode(base64url.decode(segments[0])));
    const header = decodeProtectedHeader(message);
    if (
      Object.keys(header).sort().join(',') !== 'alg,kid,typ' ||
      header.alg !== 'EdDSA' ||
      header.typ !== expectedType
    )
      throw new Error('HEADER');
    const unverified = parse(
      parseCanonical(decoder.decode(base64url.decode(segments[1]))),
    );
    const db = federationDatabase(env),
      [peer] = await db
        .select()
        .from(federationPeers)
        .where(eq(federationPeers.origin, unverified.iss));
    // Signature verification is separate from admission; waiting admission checks the current policy.
    if (!peer || header.kid !== peer.kid) throw new Error('PEER');
    const verified = await compactVerify(
      message,
      await importSPKI(peer.publicKey, 'EdDSA'),
      { algorithms: ['EdDSA'] },
    );
    const ticket = parse(parseCanonical(decoder.decode(verified.payload))),
      now = Math.floor(Date.now() / 1000);
    if (
      ticket.aud !== env.FEDERATION_ORIGIN ||
      ticket.iat > now + CLOCK_SKEW ||
      now >= ticket.exp + CLOCK_SKEW
    )
      throw new Error('TARGET_OR_TIME');
    return { ...ticket, keyRevision: peer.revision };
  } catch {
    throw new OrganizationError('PARTICIPATION_TICKET_REJECTED', 401);
  }
}
export const verifyParticipationTicket = (env: Env, message: unknown) =>
  verifyTicket(env, message, type, claims);

const loginType = 'quiz-relay-foreign-login+jws';
function loginClaims(value: unknown): ForeignLoginTicket {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SCHEMA');
  const ticket = value as ForeignLoginTicket;
  if (
    Object.keys(ticket).sort().join(',') !==
      'aud,exp,hostInstanceId,iat,iss,jti,mode,name,organizationName,protocolVersion,sourceInstanceId,state,sub' ||
    ticket.protocolVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(ticket.sub) ||
    !['ranked', 'casual', 'room'].includes(ticket.mode) ||
    !ticket.name ||
    normalizeDisplayName(ticket.name) !== ticket.name ||
    validName(ticket.organizationName) !== ticket.organizationName
  )
    throw new Error('SCHEMA');
  origin(ticket.iss);
  origin(ticket.aud);
  for (const id of [
    ticket.sourceInstanceId,
    ticket.hostInstanceId,
    ticket.state,
    ticket.jti,
  ])
    validId(id);
  if (
    !Number.isSafeInteger(ticket.iat) ||
    !Number.isSafeInteger(ticket.exp) ||
    ticket.exp <= ticket.iat ||
    ticket.exp - ticket.iat > DELIVERY_TTL
  )
    throw new Error('TIME');
  return ticket;
}
export async function signForeignLoginTicket(env: Env, ticket: ForeignLoginTicket) {
  federationDatabase(env);
  loginClaims(ticket);
  return new CompactSign(encoder.encode(canonical(ticket)))
    .setProtectedHeader(
      JSON.parse(canonical({ alg: 'EdDSA', kid: env.SIGNING_KID, typ: loginType })),
    )
    .sign(await importPKCS8(env.SIGNING_PRIVATE_KEY ?? '', 'EdDSA'));
}
export const verifyForeignLoginTicket = (env: Env, message: unknown) =>
  verifyTicket(env, message, loginType, loginClaims);
