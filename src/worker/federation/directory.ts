import { and, eq, or, sql } from 'drizzle-orm';
import {
  type ExternalInstanceDirectory,
  FEDERATION_FRESH_MS,
} from '../../shared/federation.ts';
import { changeD1, type Database, readD1 } from '../db/d1.ts';
import {
  federationFavorites,
  federationMetadata,
  federationPeers,
  federationTargets,
} from '../db/schema.ts';
import { OrganizationError, validId } from '../organization/access.ts';
import { organizationIdentity } from '../organization/database.ts';

async function directory(
  db: Database,
  subject: string,
  catalog = false,
  target?: { peerOrigin: string; instanceId: string },
): Promise<ExternalInstanceDirectory> {
  const { account, organization } = await organizationIdentity(db, subject);
  const favorites = await db
    .select()
    .from(federationFavorites)
    .where(eq(federationFavorites.actorId, account.actorId));
  const selected = (peer: string, instance: string) =>
    catalog ||
    (target?.peerOrigin === peer && target.instanceId === instance) ||
    favorites.some((row) => row.peerOrigin === peer && row.instanceId === instance);
  const peers = await db
    .select({
      origin: federationPeers.origin,
      name: federationPeers.name,
      approved: federationPeers.approved,
      discovered: federationPeers.discovered,
      participationBlocked: federationPeers.participationBlocked,
    })
    .from(federationPeers)
    .where(
      or(
        eq(federationPeers.approved, true),
        target ? eq(federationPeers.origin, target.peerOrigin) : undefined,
        sql`exists(select 1 from ${federationFavorites} where ${federationFavorites.actorId}=${account.actorId} and ${federationFavorites.peerOrigin}=${federationPeers.origin})`,
      ),
    );
  const metadata = await db
    .select()
    .from(federationMetadata)
    .where(
      and(
        eq(federationMetadata.instanceId, organization.id),
        catalog
          ? undefined
          : or(
              target ? eq(federationMetadata.peerOrigin, target.peerOrigin) : undefined,
              sql`exists(select 1 from ${federationFavorites} where ${federationFavorites.actorId}=${account.actorId} and ${federationFavorites.peerOrigin}=${federationMetadata.peerOrigin})`,
            ),
      ),
    );
  const targets = await db
    .select()
    .from(federationTargets)
    .where(
      and(
        eq(federationTargets.sourceInstanceId, organization.id),
        or(
          target
            ? and(
                eq(federationTargets.peerOrigin, target.peerOrigin),
                eq(federationTargets.instanceId, target.instanceId),
              )
            : undefined,
          sql`exists(select 1 from ${federationFavorites} where ${federationFavorites.actorId}=${account.actorId} and ${federationFavorites.peerOrigin}=${federationTargets.peerOrigin} and ${federationFavorites.instanceId}=${federationTargets.instanceId})`,
        ),
      ),
    );
  // A newer direct read or listing replaces older permissions for the same host.
  const cachedMetadata = [
    ...metadata.map((cached) => ({
      ...cached,
      direct: false,
      payload: {
        ...cached.payload,
        instances: cached.payload.instances.filter(
          (remote) =>
            !targets.some(
              (row) =>
                row.sourceInstanceId === cached.instanceId &&
                row.peerOrigin === cached.peerOrigin &&
                row.instanceId === remote.id &&
                row.checkedAt >= cached.lastSuccessAt,
            ),
        ),
      },
    })),
    ...targets
      .filter((row) => {
        const cached = metadata.find(
          (cached) =>
            cached.instanceId === row.sourceInstanceId &&
            cached.peerOrigin === row.peerOrigin,
        );
        if (!cached || row.checkedAt >= cached.lastSuccessAt) return true;
        // A partial listing cannot remove a target beyond the retrieved page.
        return (
          !cached.errorCode &&
          cached.nextCursor !== null &&
          row.instanceId > cached.nextCursor &&
          !cached.payload.instances.some((remote) => remote.id === row.instanceId)
        );
      })
      .map((row) => ({
        instanceId: row.sourceInstanceId,
        peerOrigin: row.peerOrigin,
        payload: row.payload,
        lastSuccessAt: row.checkedAt,
        errorCode: null,
        nextCursor: null,
        direct: true,
      })),
  ];
  const found = new Map<string, ExternalInstanceDirectory['instances'][number]>();
  for (const cached of cachedMetadata) {
    if (
      cached.payload.organization.id === organization.id ||
      cached.errorCode ||
      (!cached.direct && cached.lastSuccessAt < Date.now() - FEDERATION_FRESH_MS) ||
      !peers.some(
        (peer) =>
          peer.origin === cached.peerOrigin &&
          !peer.participationBlocked &&
          (peer.approved || peer.discovered),
      )
    )
      continue;
    for (const remote of cached.payload.instances) {
      if (!selected(cached.peerOrigin, remote.id)) continue;
      const ranked = remote.ranked && remote.permissions.receive.ranked;
      const casual = remote.casual && remote.permissions.receive.casual;
      if (!ranked && !casual) continue;
      const key = `${cached.peerOrigin}:${remote.id}`;
      const row = found.get(key) ?? {
        peerOrigin: cached.peerOrigin,
        instanceId: remote.id,
        name: remote.name,
        organization: cached.payload.organization.name,
        ranked: false,
        casual: false,
        favorite: favorites.some(
          (favorite) =>
            favorite.peerOrigin === cached.peerOrigin &&
            favorite.instanceId === remote.id,
        ),
        available: true,
        sources: [],
      };
      row.ranked ||= ranked;
      row.casual ||= casual;
      row.sources = [{ id: organization.id, name: organization.name, ranked, casual }];
      found.set(key, row);
    }
  }
  for (const favorite of favorites) {
    const key = `${favorite.peerOrigin}:${favorite.instanceId}`;
    if (found.has(key)) continue;
    const cached = cachedMetadata.find(
      (row) =>
        row.peerOrigin === favorite.peerOrigin &&
        row.payload.instances.some((instance) => instance.id === favorite.instanceId),
    );
    const remote = cached?.payload.instances.find(
      (instance) => instance.id === favorite.instanceId,
    );
    found.set(key, {
      peerOrigin: favorite.peerOrigin,
      instanceId: favorite.instanceId,
      name: remote?.name ?? '外部インスタンス',
      organization:
        cached?.payload.organization.name ??
        peers.find((peer) => peer.origin === favorite.peerOrigin)?.name ??
        '外部組織',
      ranked: false,
      casual: false,
      favorite: true,
      available: false,
      sources: [],
    });
  }
  return {
    organizationId: organization.id,
    peers: peers.filter((peer) => peer.approved),
    sources: [{ id: organization.id, name: organization.name }],
    instances: [...found.values()],
  };
}
export const externalInstanceDirectory = (
  db: Database,
  subject: string,
  catalog = false,
  target?: { peerOrigin: string; instanceId: string },
) => readD1(db, () => directory(db, subject, catalog, target));
export async function favoriteExternalInstance(
  db: Database,
  subject: string,
  input: Record<string, unknown>,
) {
  if (
    Object.keys(input).some(
      (key) => !['operation', 'peerOrigin', 'instanceId', 'added'].includes(key),
    ) ||
    typeof input.added !== 'boolean' ||
    typeof input.peerOrigin !== 'string'
  )
    throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
  const instanceId = validId(input.instanceId),
    peerOrigin = input.peerOrigin;
  return changeD1(db, async (writes) => {
    const { account } = await organizationIdentity(db, subject);
    const key = and(
      eq(federationFavorites.actorId, account.actorId),
      eq(federationFavorites.peerOrigin, peerOrigin),
      eq(federationFavorites.instanceId, instanceId),
    );
    if (input.added) {
      const available = (
        await directory(db, subject, false, { peerOrigin, instanceId })
      ).instances.some(
        (row) =>
          row.peerOrigin === peerOrigin && row.instanceId === instanceId && row.available,
      );
      if (!available) throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
      writes.push(
        db
          .insert(federationFavorites)
          .values({ actorId: account.actorId, peerOrigin, instanceId })
          .onConflictDoNothing(),
      );
    } else writes.push(db.delete(federationFavorites).where(key));
    return { ok: true };
  });
}
