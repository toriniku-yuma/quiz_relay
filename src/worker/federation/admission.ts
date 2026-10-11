import { and, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm';
import type { Database } from '../db/d1.ts';
import {
  federationActors,
  federationPeers,
  federationPolicies,
  federationReservations,
  organizations,
} from '../db/schema.ts';
import { OrganizationError } from '../organization/access.ts';

export function receivingParticipation(
  organization: { externalParticipation: 'approved' | 'unblocked' },
  peer:
    | {
        approved: boolean;
        participationBlocked: boolean;
        receiveRanked: boolean;
        receiveCasual: boolean;
      }
    | undefined,
  mode: 'ranked' | 'casual' | 'room',
) {
  return (
    !!peer &&
    !peer.participationBlocked &&
    (peer.approved || organization.externalParticipation === 'unblocked') &&
    (mode === 'ranked' ? peer.receiveRanked : peer.receiveCasual)
  );
}

export async function participationPolicy(
  db: Database,
  instanceId: string,
  peerOrigin: string,
  peerInstanceId: string,
  mode: 'ranked' | 'casual' | 'room',
  direction: 'send' | 'receive',
) {
  if (direction === 'send') {
    const [peer] = await db
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.origin, peerOrigin));
    const [organization] = await db.select().from(organizations);
    const [policy] =
      instanceId === organization?.id
        ? []
        : await db
            .select()
            .from(federationPolicies)
            .where(
              and(
                eq(federationPolicies.instanceId, instanceId),
                eq(federationPolicies.peerOrigin, peerOrigin),
                eq(federationPolicies.peerInstanceId, peerInstanceId),
              ),
            );
    if (
      !peer ||
      peer.participationBlocked ||
      (!peer.approved && !peer.discovered) ||
      (policy && !policy.permissions.send[mode === 'room' ? 'casual' : mode])
    )
      throw new OrganizationError('FEDERATION_PARTICIPATION_DENIED', 403);
    return;
  }
  const [[organization], [peer]] = await db.batch([
    db.select().from(organizations).limit(1),
    db.select().from(federationPeers).where(eq(federationPeers.origin, peerOrigin)),
  ]);
  if (!organization || !receivingParticipation(organization, peer, mode))
    throw new OrganizationError('FEDERATION_PARTICIPATION_DENIED', 403);
}

// Foreign identities never inherit ordinary local membership. A current, scoped
// home authorization and the host's receive policy are both required while waiting.
export async function federationAllowedActors(
  db: Database,
  scope: { id: string; mode?: 'casual' | 'room' },
  actors: string[],
  matchId?: string,
  pendingActors: string[] = [],
) {
  if (!actors.length) return [];
  const foreign = await db
    .select({ actorId: federationActors.actorId })
    .from(federationActors)
    .where(inArray(federationActors.actorId, actors));
  if (!foreign.length) return actors;
  const reservations = await db
    .select({
      actorId: federationReservations.actorId,
      peer: federationPeers,
    })
    .from(federationReservations)
    .innerJoin(
      federationPeers,
      eq(federationPeers.origin, federationReservations.peerOrigin),
    )
    .where(
      and(
        eq(federationReservations.instanceId, scope.id),
        matchId
          ? or(
              scope.mode === 'room'
                ? eq(federationReservations.roomId, matchId)
                : eq(federationReservations.matchId, matchId),
              pendingActors.length
                ? and(
                    isNull(federationReservations.matchId),
                    eq(federationReservations.state, 'creating'),
                    inArray(federationReservations.actorId, pendingActors),
                  )
                : undefined,
            )
          : undefined,
        eq(federationReservations.mode, scope.mode ?? 'ranked'),
        inArray(
          federationReservations.actorId,
          foreign.map((row) => row.actorId),
        ),
        ne(federationReservations.state, 'closed'),
        gt(federationReservations.allowedUntil, Date.now()),
      ),
    );
  const [organization] = await db.select().from(organizations);
  const allowed = new Set(
    reservations
      .filter(
        (row) =>
          organization &&
          receivingParticipation(organization, row.peer, scope.mode ?? 'ranked'),
      )
      .map((row) => row.actorId),
  );
  const foreignIds = new Set(foreign.map((row) => row.actorId));
  return actors.filter((actor) => !foreignIds.has(actor) || allowed.has(actor));
}
