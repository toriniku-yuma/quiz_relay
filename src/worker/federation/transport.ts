import { eq, sql } from 'drizzle-orm';
import { base64url, importPKCS8, importSPKI } from 'jose';
import { connectD1, type Database } from '../db/d1.ts';
import {
  federationNonces,
  federationParticipations,
  federationPeers,
  federationReservations,
  organizations,
} from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError } from '../organization/access.ts';
import { discoverPeer } from './discovery.ts';
import { peerRequest, rejectRedirect } from './egress.ts';
import {
  bodyHash,
  DELIVERY_TTL,
  type Delivery,
  MAX_MESSAGE_BYTES,
  origin,
  parseCanonical,
  signDelivery,
  verifyDelivery,
} from './signatures.ts';

export async function boundedText(request: Request | Response, max = MAX_MESSAGE_BYTES) {
  if (Number(request.headers.get('Content-Length')) > max)
    throw new OrganizationError('FEDERATION_MESSAGE_SIZE', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new OrganizationError('INVALID_FEDERATION_REQUEST', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new OrganizationError('FEDERATION_MESSAGE_SIZE', 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(result);
}
export async function consumeNonce(
  db: Database,
  issuer: string,
  purpose: string,
  nonce: string,
  expiresAt: number,
) {
  // The unique key consumes a nonce atomically, independently of business snapshots.
  return (
    (
      await db
        .insert(federationNonces)
        .values({ issuer, purpose, nonce, expiresAt })
        .onConflictDoNothing()
        .returning({ nonce: federationNonces.nonce })
    ).length === 1
  );
}
export async function expireFederationNonces(db: Database) {
  const now = Math.floor(Date.now() / 1000);
  await db
    .delete(federationNonces)
    .where(
      sql`(${federationNonces.issuer},${federationNonces.purpose},${federationNonces.nonce}) in (select ${federationNonces.issuer},${federationNonces.purpose},${federationNonces.nonce} from ${federationNonces} where ${federationNonces.expiresAt}<${now} order by ${federationNonces.expiresAt} limit 100)`,
    );
}
// Federation is off only when none of its settings exist; a partial setting fails.
export function federationEnabled(env: Env) {
  if (!env.FEDERATION_ORIGIN && !env.SIGNING_KID && !env.SIGNING_PRIVATE_KEY)
    return false;
  federationConfig(env);
  return true;
}
export function federationConfig(env: Env) {
  if (!env.FEDERATION_ORIGIN || !env.SIGNING_KID || !env.SIGNING_PRIVATE_KEY)
    throw new OrganizationError('FEDERATION_NOT_CONFIGURED', 503);
  return {
    origin: origin(env.FEDERATION_ORIGIN),
    kid: env.SIGNING_KID,
    privateKey: env.SIGNING_PRIVATE_KEY,
  };
}
export function federationDatabase(env: Env) {
  if (!env.GAME_D1) throw new OrganizationError('FEDERATION_NOT_CONFIGURED', 503);
  federationConfig(env);
  return connectD1(env.GAME_D1);
}
function federationLimiter(env: Env) {
  if (!env.FEDERATION_LIMITER)
    throw new OrganizationError('FEDERATION_NOT_CONFIGURED', 503);
  return env.FEDERATION_LIMITER;
}
export async function receiveDelivery(
  request: Request,
  env: Env,
  messageType: Delivery['messageType'],
  max = MAX_MESSAGE_BYTES,
  expected?: { issuer?: string; replyTo?: string; participation?: boolean },
) {
  const db = federationDatabase(env),
    config = federationConfig(env),
    limiter = federationLimiter(env);
  let envelope: unknown;
  try {
    envelope = parseCanonical(await boundedText(request, max));
  } catch (error) {
    if (error instanceof OrganizationError) throw error;
    throw new OrganizationError('FEDERATION_SIGNATURE_REJECTED', 401);
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    Object.keys(envelope).join(',') !== 'message' ||
    typeof (envelope as { message: unknown }).message !== 'string'
  )
    throw new OrganizationError('FEDERATION_SIGNATURE_REJECTED', 401);
  const message = (envelope as { message: string }).message;
  let issuer: string;
  try {
    if (message.length > max) throw new Error('SIZE');
    const payload = parseCanonical(
      new TextDecoder('utf-8', { fatal: true }).decode(
        base64url.decode(message.split('.')[1]),
      ),
    );
    issuer = origin(String((payload as { issuer?: unknown })?.issuer));
  } catch {
    throw new OrganizationError('FEDERATION_SIGNATURE_REJECTED', 401);
  }
  if (expected?.issuer && issuer !== expected.issuer)
    throw new OrganizationError('FEDERATION_SIGNATURE_REJECTED', 401);
  let [peer] = await db
    .select()
    .from(federationPeers)
    .where(eq(federationPeers.origin, issuer));
  const path = new URL(request.url).pathname;
  const admission =
    (messageType === 'metadata.request' && path === '/federation/v1/metadata') ||
    (messageType === 'reservation.request' &&
      path === '/api/v1/participation/reservations');
  if (!peer && admission) {
    const [organization] = await db.select().from(organizations).limit(1);
    if (organization?.externalParticipation === 'unblocked') {
      if (!env.API_LIMITER)
        throw new OrganizationError('RATE_LIMITER_NOT_CONFIGURED', 503);
      if (
        !(
          await env.API_LIMITER.limit({
            key: `discovery-ip:${request.headers.get('CF-Connecting-IP') ?? 'local'}`,
          })
        ).success
      )
        throw new OrganizationError('RATE_LIMIT', 429);
      await discoverPeer(env, issuer);
      [peer] = await db
        .select()
        .from(federationPeers)
        .where(eq(federationPeers.origin, issuer));
    }
  }
  const scoped =
    admission ||
    expected?.participation ||
    (messageType === 'reservation.request' &&
      [
        '/federation/v1/participation/validate',
        '/federation/v1/participation/authorize',
        '/federation/v1/participation/authorize',
      ].includes(new URL(request.url).pathname)) ||
    (messageType === 'event' &&
      ['/federation/v1/inbox', '/federation/v1/results/review'].includes(path));
  if (!peer || (!peer.approved && !scoped))
    throw new OrganizationError('UNAPPROVED_PEER', 403);
  if (
    !peer.approved &&
    messageType === 'event' &&
    new URL(request.url).pathname === '/federation/v1/inbox'
  ) {
    const [consent] = await db
      .select({ id: federationParticipations.reservationId })
      .from(federationParticipations)
      .where(eq(federationParticipations.peerOrigin, issuer))
      .limit(1);
    const [hosted] = consent
      ? []
      : await db
          .select({ id: federationReservations.id })
          .from(federationReservations)
          .where(eq(federationReservations.peerOrigin, issuer))
          .limit(1);
    if (!consent && !hosted) throw new OrganizationError('UNAPPROVED_PEER', 403);
  }
  try {
    const delivery = await verifyDelivery(message, {
      issuer,
      audience: config.origin,
      kid: peer.kid,
      key: await importSPKI(peer.publicKey, 'EdDSA'),
      now: Math.floor(Date.now() / 1000),
      messageType,
      path: new URL(request.url).pathname,
      maxBytes: max,
      replyTo: expected?.replyTo,
      consumeNonce: async (nonce, until) => {
        if (!(await limiter.limit({ key: `peer:${issuer}` })).success)
          throw new OrganizationError('RATE_LIMIT', 429);
        return consumeNonce(
          db,
          issuer,
          `${messageType}:${new URL(request.url).pathname}`,
          nonce,
          until,
        );
      },
    });
    // Recheck manual approval after the signature and nonce operation.
    const [current] = await db
      .select()
      .from(federationPeers)
      .where(eq(federationPeers.origin, issuer));
    if (!current || (!current.approved && !scoped) || current.revision !== peer.revision)
      throw new OrganizationError('UNAPPROVED_PEER', 403);
    if (env.ROOM_LIFECYCLE_LOGS === 'true')
      console.log(
        JSON.stringify({
          event: 'federation_request',
          peerOrigin: issuer,
          at: Date.now(),
        }),
      );
    return delivery;
  } catch (error) {
    if (error instanceof OrganizationError) throw error;
    throw new OrganizationError(
      error instanceof Error && error.message === 'REPLAY'
        ? 'FEDERATION_REPLAY'
        : 'FEDERATION_SIGNATURE_REJECTED',
      error instanceof Error && error.message === 'REPLAY' ? 409 : 401,
    );
  }
}
export async function signedDelivery(
  env: Env,
  peerOrigin: string,
  path: string,
  messageType: Delivery['messageType'],
  body: unknown,
  options: { nonce?: string; replyTo?: string } = {},
) {
  const config = federationConfig(env),
    now = Math.floor(Date.now() / 1000);
  const bodyValue = JSON.parse(JSON.stringify(body)) as Delivery['body'];
  return signDelivery(
    {
      protocolVersion: 1,
      messageType,
      issuer: config.origin,
      audience: peerOrigin,
      issuedAt: now,
      expiresAt: now + DELIVERY_TTL,
      nonce: options.nonce ?? crypto.randomUUID(),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      method: 'POST',
      path,
      bodyHash: await bodyHash(bodyValue),
      body: bodyValue,
    },
    await importPKCS8(config.privateKey, 'EdDSA'),
    config.kid,
  );
}
export async function requestPeer(
  env: Env,
  peerOrigin: string,
  path: string,
  messageType: Delivery['messageType'],
  responseType: Delivery['messageType'],
  body: unknown,
  max = MAX_MESSAGE_BYTES,
  participation = false,
) {
  const db = federationDatabase(env);
  const [peer] = await db
    .select()
    .from(federationPeers)
    .where(eq(federationPeers.origin, peerOrigin));
  if (!peer || (!peer.approved && !participation))
    throw new OrganizationError('UNAPPROVED_PEER', 403);
  if (
    participation &&
    ![
      '/federation/v1/metadata',
      '/api/v1/participation/reservations',
      '/federation/v1/participation/validate',
      '/federation/v1/participation/authorize',
      '/federation/v1/inbox',
      '/federation/v1/results/review',
    ].includes(path)
  )
    throw new OrganizationError('UNAPPROVED_PEER', 403);
  const nonce = crypto.randomUUID();
  const message = await signedDelivery(env, peerOrigin, path, messageType, body, {
    nonce,
  });
  const request = peerRequest(peerOrigin, [peer.origin], path, message);
  const timeoutMs = 5000;
  const signal = AbortSignal.timeout(timeoutMs),
    startedAt = Date.now();
  let response: Response;
  try {
    response = rejectRedirect(await fetch(request, { signal }));
  } catch {
    console.error(
      JSON.stringify({
        event: 'federation_peer_failed',
        code: signal.aborted ? 'FEDERATION_PEER_TIMEOUT' : 'FEDERATION_PEER_TRANSPORT',
        path,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
      }),
    );
    throw new OrganizationError('FEDERATION_PEER_UNAVAILABLE', 503);
  }
  if (!response.ok) {
    console.error(
      JSON.stringify({
        event: 'federation_peer_failed',
        code: 'FEDERATION_PEER_HTTP',
        path,
        peerStatus: response.status,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
      }),
    );
    const error = new OrganizationError(
      response.status === 429
        ? 'FEDERATION_PEER_RATE_LIMIT'
        : 'FEDERATION_PEER_UNAVAILABLE',
      503,
    );
    error.peerStatus = response.status;
    if (response.status === 429) {
      const header = response.headers.get('Retry-After');
      const retryAt =
        header && /^\d+$/.test(header)
          ? Date.now() + Number(header) * 1000
          : header
            ? Date.parse(header)
            : NaN;
      if (Number.isFinite(retryAt))
        error.retryAt = Math.min(Date.now() + 86400000, retryAt);
    }
    throw error;
  }
  return receiveDelivery(
    new Request(`${federationConfig(env).origin}${path}`, {
      method: 'POST',
      body: await boundedText(response, max),
    }),
    env,
    responseType,
    max,
    { issuer: peerOrigin, replyTo: nonce, participation },
  );
}
