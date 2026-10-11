import { createPublicKey } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { exportSPKI, importSPKI } from 'jose';
import { API_PATHS } from '../../shared/api-paths.ts';
import { externalInstanceUrl } from '../../shared/external-instance.ts';
import { changeD1, rowsD1 } from '../db/d1.ts';
import { federationPeerKeys, federationPeers, federationTargets } from '../db/schema.ts';
import type { Env } from '../env.ts';
import {
  OrganizationError,
  requireAdministrator,
  validId,
} from '../organization/access.ts';
import { organizationIdentity } from '../organization/database.ts';
import { externalInstanceDirectory } from './directory.ts';
import { peerRequest, rejectRedirect } from './egress.ts';
import { METADATA_PATH, parseMetadata } from './metadata.ts';
import { participationSource } from './participation-source.ts';
import { boundedText, federationDatabase, requestPeer } from './transport.ts';

export function publicPeerKey(env: Env) {
  federationDatabase(env);
  return {
    origin: env.FEDERATION_ORIGIN,
    kid: env.SIGNING_KID,
    publicKey: createPublicKey(env.SIGNING_PRIVATE_KEY ?? '')
      .export({ type: 'spki', format: 'pem' })
      .toString(),
  };
}
export async function fetchPeerKey(peerOrigin: string) {
  let key: { origin: string; kid: string; publicKey: string };
  try {
    // The same restrictive destination profile as signed traffic; only this fixed GET path.
    const request = peerRequest(peerOrigin, [peerOrigin], API_PATHS.federationKey, '');
    const response = rejectRedirect(
      await fetch(new Request(request.url, { redirect: 'manual' }), {
        signal: AbortSignal.timeout(5000),
      }),
    );
    if (!response.ok) throw new Error('STATUS');
    key = JSON.parse(await boundedText(response, 4096));
    if (
      Object.keys(key).sort().join(',') !== 'kid,origin,publicKey' ||
      key.origin !== peerOrigin ||
      typeof key.kid !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(key.kid) ||
      typeof key.publicKey !== 'string' ||
      key.publicKey.length > 2048
    )
      throw new Error('KEY');
    key.publicKey = await exportSPKI(await importSPKI(key.publicKey, 'EdDSA'));
  } catch {
    throw new OrganizationError('FEDERATION_DISCOVERY_FAILED', 503);
  }
  return key;
}
export async function discoverPeer(env: Env, peerOrigin: string) {
  const db = federationDatabase(env);
  const [existing] = await db
    .select()
    .from(federationPeers)
    .where(eq(federationPeers.origin, peerOrigin));
  if (existing) return;
  const key = await fetchPeerKey(peerOrigin);
  await changeD1(db, async (writes) => {
    const [current] = await db
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.origin, peerOrigin));
    if (current) return; // Never overwrite a pinned key or an administrative prohibition.
    writes.push(
      db.insert(federationPeers).values({
        origin: peerOrigin,
        name: new URL(peerOrigin).hostname,
        kid: key.kid,
        publicKey: key.publicKey,
        approved: false,
        discovered: true,
      }),
      db.insert(federationPeerKeys).values({
        origin: peerOrigin,
        kid: key.kid,
        publicKey: key.publicKey,
        createdAt: new Date().toISOString(),
      }),
    );
  });
}
export async function preparePeer(
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  if (
    Object.keys(input).sort().join(',') !== 'operation,origin,rotate' ||
    typeof input.origin !== 'string' ||
    typeof input.rotate !== 'boolean'
  )
    throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
  const db = federationDatabase(env);
  requireAdministrator((await organizationIdentity(db, subject)).account);
  try {
    peerRequest(input.origin, [input.origin], API_PATHS.federationKey, '');
  } catch {
    throw new OrganizationError('INVALID_PEER_ORIGIN', 400);
  }
  await discoverPeer(env, input.origin);
  const [peer] = await db
    .select()
    .from(federationPeers)
    .where(eq(federationPeers.origin, input.origin));
  return input.rotate ? { ...peer, ...(await fetchPeerKey(input.origin)) } : peer;
}
export async function resolveExternalInstance(
  env: Env,
  subject: string,
  input: Record<string, unknown>,
) {
  if (
    !['operation,url', 'operation,sourceInstanceId,url'].includes(
      Object.keys(input).sort().join(','),
    )
  )
    throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
  let target: ReturnType<typeof externalInstanceUrl>;
  try {
    target = externalInstanceUrl(input.url);
  } catch {
    throw new OrganizationError('INVALID_INSTANCE_URL', 400);
  }
  if (target.peerOrigin === env.FEDERATION_ORIGIN)
    throw new OrganizationError('INVALID_INSTANCE_URL', 400);
  const db = federationDatabase(env),
    identity = await organizationIdentity(db, subject),
    sourceInstanceId =
      input.sourceInstanceId === undefined
        ? identity.organization.id
        : validId(input.sourceInstanceId);
  await participationSource(db, subject, sourceInstanceId);
  await discoverPeer(env, target.peerOrigin);
  const [peer] = await db
    .select()
    .from(federationPeers)
    .where(eq(federationPeers.origin, target.peerOrigin));
  if (peer.participationBlocked || (!peer.approved && !peer.discovered))
    throw new OrganizationError('FEDERATION_PARTICIPATION_DENIED', 403);
  const reply = await requestPeer(
    env,
    target.peerOrigin,
    METADATA_PATH,
    'metadata.request',
    'metadata.response',
    { sourceInstanceId, targetInstanceId: target.instanceId },
    16384,
    true,
  );
  const payload = parseMetadata(reply.body, sourceInstanceId);
  if (
    payload.nextCursor !== null ||
    payload.instances.length !== 1 ||
    payload.instances[0].id !== target.instanceId
  )
    throw new OrganizationError('FEDERATION_TARGET_UNAVAILABLE', 409);
  await changeD1(db, async (writes) => {
    await participationSource(db, subject, sourceInstanceId);
    writes.push(
      rowsD1(
        federationTargets,
        [{ sourceInstanceId, ...target, payload, checkedAt: Date.now() }],
        true,
      ),
    );
  });
  return {
    ...target,
    instance: (
      await externalInstanceDirectory(db, subject, false, target)
    ).instances.find(
      (row) =>
        row.peerOrigin === target.peerOrigin && row.instanceId === target.instanceId,
    ),
  };
}
