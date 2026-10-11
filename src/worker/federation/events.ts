import { and, eq } from 'drizzle-orm';
import {
  base64url,
  CompactSign,
  compactVerify,
  decodeProtectedHeader,
  importPKCS8,
  importSPKI,
} from 'jose';
import { federationPeerKeys, federationPeers } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { OrganizationError } from '../organization/access.ts';
import { canonical, parseCanonical } from './signatures.ts';
import { federationDatabase } from './transport.ts';

const type = 'quiz-relay-event+jws';
export async function signEvent(env: Env, payload: unknown) {
  return new CompactSign(
    new TextEncoder().encode(canonical({ issuer: env.FEDERATION_ORIGIN, payload })),
  )
    .setProtectedHeader(
      JSON.parse(canonical({ alg: 'EdDSA', kid: env.SIGNING_KID, typ: type })),
    )
    .sign(await importPKCS8(env.SIGNING_PRIVATE_KEY ?? '', 'EdDSA'));
}
export async function verifyEvent(env: Env, issuer: string, value: unknown) {
  try {
    if (
      typeof value !== 'string' ||
      value.length > 65536 ||
      value.split('.').length !== 3
    )
      throw new Error('SIZE');
    const header = decodeProtectedHeader(value),
      decoder = new TextDecoder('utf-8', { fatal: true });
    parseCanonical(decoder.decode(base64url.decode(value.split('.')[0])));
    if (
      Object.keys(header).sort().join(',') !== 'alg,kid,typ' ||
      header.alg !== 'EdDSA' ||
      header.typ !== type ||
      typeof header.kid !== 'string'
    )
      throw new Error('HEADER');
    const db = federationDatabase(env),
      [key] = await db
        .select()
        .from(federationPeerKeys)
        .where(
          and(
            eq(federationPeerKeys.origin, issuer),
            eq(federationPeerKeys.kid, header.kid),
          ),
        ),
      [current] = await db
        .select()
        .from(federationPeers)
        .where(eq(federationPeers.origin, issuer));
    const publicKey =
      key?.publicKey ?? (current?.kid === header.kid ? current.publicKey : undefined);
    if (!publicKey) throw new Error('KEY');
    const verified = await compactVerify(value, await importSPKI(publicKey, 'EdDSA'), {
      algorithms: ['EdDSA'],
    });
    const event = parseCanonical(decoder.decode(verified.payload)) as {
      issuer?: unknown;
      payload?: unknown;
    };
    if (
      !event ||
      Object.keys(event).sort().join(',') !== 'issuer,payload' ||
      event.issuer !== issuer
    )
      throw new Error('ISSUER');
    return event.payload;
  } catch {
    throw new OrganizationError('FEDERATION_EVENT_REJECTED', 401);
  }
}
