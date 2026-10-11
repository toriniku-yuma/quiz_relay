import { and, eq, gt, ne, or } from 'drizzle-orm';
import type { ForeignAccount, ParticipationTarget } from '../../shared/participation.ts';
import { FOREIGN_LOGIN_LIFETIME } from '../../shared/participation.ts';
import { contentHash } from '../catalog/hash.ts';
import { changeD1 } from '../db/d1.ts';
import {
  federationLoginSessions,
  federationNonces,
  federationPeers,
  federationReservations,
  federationRetiredIdentities,
  instances,
  organizations,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import { organizationIdentity } from '../organization/database.ts';
import { participationPolicy } from './admission.ts';
import { discoverPeer } from './discovery.ts';
import { participationMode } from './participation.ts';
import { origin } from './signatures.ts';
import { logoutHostParticipation, releaseHostParticipation } from './slots.ts';
import { signForeignLoginTicket, verifyForeignLoginTicket } from './tickets.ts';
import { federationDatabase } from './transport.ts';

function object(value: unknown, keys: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys
  )
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  return value as Record<string, unknown>;
}
function target(value: Record<string, unknown>): ParticipationTarget {
  return {
    peerOrigin: origin(String(value.peerOrigin)),
    sourceInstanceId: validId(value.sourceInstanceId),
    hostInstanceId: validId(value.hostInstanceId),
    mode: participationMode(value.mode),
  };
}
export async function authorizeForeignLogin(env: Env, subject: string, value: unknown) {
  const input = object(value, 'hostInstanceId,mode,peerOrigin,sourceInstanceId,state'),
    request = target(input),
    state = validId(input.state),
    db = federationDatabase(env),
    identity = await organizationIdentity(db, subject);
  if (request.sourceInstanceId !== identity.organization.id)
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  if (!identity.account.displayName) throw new OrganizationError('PROFILE_REQUIRED', 409);
  await participationPolicy(
    db,
    request.sourceInstanceId,
    request.peerOrigin,
    request.hostInstanceId,
    request.mode,
    'send',
  );
  const now = Math.floor(Date.now() / 1000);
  // Login creates neither a participation slot nor a host reservation/account.
  return {
    ticket: await signForeignLoginTicket(env, {
      protocolVersion: 1,
      iss: env.FEDERATION_ORIGIN ?? '',
      aud: request.peerOrigin,
      sub: identity.account.actorId,
      sourceInstanceId: identity.organization.id,
      hostInstanceId: request.hostInstanceId,
      mode: request.mode,
      name: identity.account.displayName,
      organizationName: identity.organization.name,
      state,
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 60,
    }),
  };
}
type Login = typeof federationLoginSessions.$inferSelect;
export function publicForeignAccount(row: Login): ForeignAccount {
  return {
    homeOrigin: row.peerOrigin,
    organizationId: row.sourceOrganizationId,
    organizationName: row.organizationName,
    sourceActorId: row.sourceActorId,
    name: row.displayName,
    expiresAt: row.expiresAt,
  };
}
export async function exchangeForeignLogin(env: Env, value: unknown) {
  const input = object(
      value,
      'hostInstanceId,mode,peerOrigin,sourceInstanceId,state,ticket',
    ),
    request = target(input),
    state = validId(input.state),
    db = federationDatabase(env);
  const [organization] = await db.select().from(organizations).limit(1);
  if (organization?.externalParticipation === 'unblocked')
    await discoverPeer(env, request.peerOrigin);
  const proof = await verifyForeignLoginTicket(env, input.ticket);
  if (
    proof.iss !== request.peerOrigin ||
    proof.state !== state ||
    proof.sourceInstanceId !== request.sourceInstanceId ||
    proof.hostInstanceId !== request.hostInstanceId ||
    proof.mode !== request.mode
  )
    throw new OrganizationError('PARTICIPATION_TICKET_BINDING', 401);
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const row: Login = {
    hash: await contentHash(secret),
    peerOrigin: proof.iss,
    sourceOrganizationId: proof.sourceInstanceId,
    sourceActorId: proof.sub,
    displayName: proof.name,
    organizationName: proof.organizationName,
    expiresAt: Date.now() + FOREIGN_LOGIN_LIFETIME,
  };
  await changeD1(db, async (writes) => {
    const [instance] = await db
      .select()
      .from(instances)
      .where(eq(instances.id, proof.hostInstanceId));
    const [peer] = await db
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.origin, proof.iss));
    if (instance?.state !== 'published' || peer?.revision !== proof.keyRevision)
      throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
    await participationPolicy(
      db,
      instance.id,
      proof.iss,
      proof.sourceInstanceId,
      proof.mode,
      'receive',
    );
    const [retired] = await db
      .select()
      .from(federationRetiredIdentities)
      .where(
        and(
          eq(federationRetiredIdentities.peerOrigin, proof.iss),
          eq(federationRetiredIdentities.actorId, proof.sub),
        ),
      );
    if (retired) throw new OrganizationError('ACCOUNT_WITHDRAWN', 403);
    const [used] = await db
      .select()
      .from(federationNonces)
      .where(
        and(
          eq(federationNonces.issuer, proof.iss),
          eq(federationNonces.purpose, 'foreign-login'),
          eq(federationNonces.nonce, proof.jti),
        ),
      );
    if (used) throw new OrganizationError('PARTICIPATION_TICKET_REPLAY', 409);
    if (Date.now() >= (proof.exp + 5) * 1000)
      throw new OrganizationError('PARTICIPATION_TICKET_REJECTED', 401);
    writes.push(
      db.insert(federationNonces).values({
        issuer: proof.iss,
        purpose: 'foreign-login',
        nonce: proof.jti,
        expiresAt: proof.exp + 5,
      }),
      db.insert(federationLoginSessions).values(row),
    );
  });
  return { secret, row };
}
export async function foreignLoginSession(env: Env, secret: string) {
  if (!/^[a-f0-9-]{72}$/.test(secret))
    throw new OrganizationError('SESSION_REQUIRED', 401);
  const db = federationDatabase(env);
  const [row] = await db
    .select()
    .from(federationLoginSessions)
    .where(
      and(
        eq(federationLoginSessions.hash, await contentHash(secret)),
        gt(federationLoginSessions.expiresAt, Date.now()),
      ),
    );
  if (!row) throw new OrganizationError('SESSION_REQUIRED', 401);
  return row;
}
export async function logoutForeignLogin(env: Env, secret: string) {
  const row = await foreignLoginSession(env, secret);
  return logoutForeignAccount(env, row.peerOrigin, row.sourceActorId);
}
export async function logoutForeignAccount(
  env: Env,
  peerOrigin: string,
  sourceActorId: string,
) {
  const db = federationDatabase(env);
  const reservations = await db
    .select()
    .from(federationReservations)
    .where(
      and(
        eq(federationReservations.peerOrigin, peerOrigin),
        eq(federationReservations.sourceActorId, sourceActorId),
        ne(federationReservations.state, 'closed'),
        or(
          gt(federationReservations.sessionExpiresAt, Date.now()),
          and(
            eq(federationReservations.state, 'creating'),
            gt(federationReservations.expiresAt, Date.now()),
          ),
        ),
      ),
    );
  for (const reservation of reservations) {
    if (reservation.state === 'creating')
      await releaseHostParticipation(env, peerOrigin, {
        sourceActorId,
        operationId: reservation.operationId,
      });
    else
      await logoutHostParticipation(env, peerOrigin, {
        sourceActorId,
        authorizationId: reservation.authorizationId,
        operationId: reservation.operationId,
      });
  }
  await changeD1(db, async (writes) => {
    for (const reservation of reservations)
      writes.push(
        db
          .update(federationReservations)
          .set({ state: 'closed', allowedUntil: 0 })
          .where(eq(federationReservations.id, reservation.id)),
      );
    writes.push(
      db
        .delete(federationLoginSessions)
        .where(
          and(
            eq(federationLoginSessions.peerOrigin, peerOrigin),
            eq(federationLoginSessions.sourceActorId, sourceActorId),
          ),
        ),
    );
  });
  return reservations.map((reservation) => reservation.id);
}
