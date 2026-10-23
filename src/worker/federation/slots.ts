import { and, eq, lte, ne, or, sql } from 'drizzle-orm';
import { changeD1 } from '../db/d1.ts';
import {
  federationLoginSessions,
  federationReservations,
  federationSessions,
  organizations,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { matchmaker } from '../matchmaking/instance.ts';
import { actorForSubject, OrganizationError, validId } from '../organization/access.ts';
import { federationDatabase } from './transport.ts';

export async function expireHostParticipations(env: Env, now = Date.now()) {
  const db = federationDatabase(env);
  const due = await db
    .select()
    .from(federationReservations)
    .where(
      and(
        ne(federationReservations.state, 'closed'),
        or(
          and(
            eq(federationReservations.state, 'exchanged'),
            lte(federationReservations.sessionExpiresAt, now),
          ),
          and(
            ne(federationReservations.state, 'exchanged'),
            lte(federationReservations.expiresAt, now),
          ),
        ),
      ),
    )
    .orderBy(federationReservations.expiresAt, federationReservations.id)
    .limit(2);
  let failed = false;
  for (const row of due)
    try {
      await releaseHostParticipation(env, row.peerOrigin, {
        operationId: row.operationId,
        sourceActorId: row.sourceActorId,
      });
    } catch {
      failed = true;
    }
  if (failed) throw new OrganizationError('PARTICIPATION_RELEASE_PENDING', 503);
  return due.length < 2;
}
export async function expireFederationSessions(env: Env, now = Date.now()) {
  const db = federationDatabase(env);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .delete(federationLoginSessions)
        .where(
          sql`${federationLoginSessions.hash} in (select ${federationLoginSessions.hash} from ${federationLoginSessions} where ${federationLoginSessions.expiresAt}<=${now} order by ${federationLoginSessions.expiresAt} limit 100)`,
        ),
      db
        .delete(federationSessions)
        .where(
          sql`${federationSessions.hash} in (select ${federationSessions.hash} from ${federationSessions} where ${federationSessions.expiresAt}<=${now} order by ${federationSessions.expiresAt} limit 100)`,
        ),
    );
  });
}
function inputOperation(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !== 'operationId,sourceActorId' ||
    typeof input.sourceActorId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.sourceActorId)
  )
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  return { operationId: validId(input.operationId), sourceActorId: input.sourceActorId };
}
export async function releaseHostParticipation(
  env: Env,
  peerOrigin: string,
  value: unknown,
) {
  const input = inputOperation(value),
    db = federationDatabase(env),
    [organization] = await db.select().from(organizations);
  if (!organization) throw new OrganizationError('SETUP_REQUIRED', 409);
  const actorId = await actorForSubject(
    organization.identityNamespace,
    `federation:${peerOrigin}:${input.sourceActorId}`,
  );
  const [row] = await db
    .select()
    .from(federationReservations)
    .where(
      and(
        eq(federationReservations.peerOrigin, peerOrigin),
        eq(federationReservations.operationId, input.operationId),
      ),
    );
  if (!row) return { ok: true };
  if (row.sourceActorId !== input.sourceActorId)
    throw new OrganizationError('PARTICIPATION_BINDING', 403);
  if (row.state === 'closed') return { ok: true };
  const maker = matchmaker(env);
  if (row?.roomId) {
    const result = await maker.cancel(actorId, row.roomId, true, row.instanceId, true);
    if (!result.ok && result.code !== 'STALE_ROOM')
      throw new OrganizationError('PARTICIPATION_RELEASE_PENDING', 503);
    // STALE_ROOM means a newer allocation is current. Close only this operation;
    // cancelAdmission is bound to its saved generation and cannot evict the new one.
  }
  const result = await maker.cancelAdmission(
    actorId,
    input.operationId,
    row?.instanceId,
    row?.mode === 'ranked' ? undefined : row?.mode,
  );
  if (!result.ok) throw new OrganizationError('PARTICIPATION_RELEASE_PENDING', 503);
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(federationReservations)
        .set({ state: 'closed', allowedUntil: 0 })
        .where(eq(federationReservations.id, row.id)),
    );
  });
  return { ok: true };
}
export async function logoutHostParticipation(
  env: Env,
  peerOrigin: string,
  value: unknown,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'authorizationId,operationId,sourceActorId')
    throw new OrganizationError('INVALID_PARTICIPATION', 400);
  const authorizationId = validId(input.authorizationId),
    operation = inputOperation({
      operationId: input.operationId,
      sourceActorId: input.sourceActorId,
    }),
    db = federationDatabase(env);
  const [row] = await db
    .select()
    .from(federationReservations)
    .where(
      and(
        eq(federationReservations.peerOrigin, peerOrigin),
        eq(federationReservations.operationId, operation.operationId),
      ),
    );
  if (!row) return { ok: true };
  if (row.sourceActorId !== operation.sourceActorId)
    throw new OrganizationError('PARTICIPATION_BINDING', 403);
  if (row.authorizationId !== authorizationId) return { ok: true };
  await changeD1(db, async (writes) => {
    writes.push(
      db.delete(federationSessions).where(eq(federationSessions.reservationId, row.id)),
      db
        .update(federationReservations)
        .set({ allowedUntil: 0 })
        .where(eq(federationReservations.id, row.id)),
    );
  });
  const [organization] = await db.select().from(organizations);
  if (row.roomId && organization) {
    const result = await matchmaker(env).cancel(
      row.actorId,
      row.roomId,
      true,
      row.instanceId,
      false,
    );
    if (!result.ok && result.code !== 'STALE_ROOM')
      throw new OrganizationError('PARTICIPATION_LOGOUT_PENDING', 503);
  }
  return { ok: true };
}
