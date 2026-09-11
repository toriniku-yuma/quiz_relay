import canonicalize from 'canonicalize';
import {
  base64url,
  CompactSign,
  compactVerify,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
} from 'jose';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const DELIVERY_TTL = 60;
export const CLOCK_SKEW = 5;
export const MAX_MESSAGE_BYTES = 256 * 1024;
export const DELIVERY_TYPE = 'quiz-relay-delivery+jws';
export const INBOX_PATH = '/federation/v1/inbox';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Delivery {
  protocolVersion: 1;
  messageType: 'probe';
  issuer: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  method: 'POST';
  path: typeof INBOX_PATH;
  bodyHash: string;
  body: Json;
}

export function canonical(value: unknown): string {
  let nodes = 0;
  function check(item: unknown, depth: number) {
    if (++nodes > 10000 || depth > 32) throw new Error('JSON_LIMIT');
    if (typeof item === 'string') {
      if (/[\uD800-\uDFFF]/u.test(item)) throw new Error('JSON_UNICODE');
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('JSON_NUMBER');
    } else if (item !== null && typeof item === 'object') {
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
        throw new Error('JSON_TYPE');

      for (const [key, child] of Object.entries(item)) {
        check(key, depth + 1);
        check(child, depth + 1);
      }
    } else if (item !== null && typeof item !== 'boolean') throw new Error('JSON_TYPE');
  }

  check(value, 0);
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new Error('JSON_TYPE');

  return serialized;
}

// Requiring canonical JSON on the wire also rejects duplicate keys before use.
export function parseCanonical(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (canonical(value) !== text) throw new Error('NON_CANONICAL_JSON');

  return value;
}

export async function bodyHash(body: unknown) {
  return base64url.encode(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(canonical(body))),
    ),
  );
}

export function origin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
    throw new Error('INVALID_ORIGIN');

  return url.origin;
}

export async function signDelivery(delivery: Delivery, key: CryptoKey, kid: string) {
  const header = { alg: 'EdDSA', kid, typ: DELIVERY_TYPE };
  // CompactSign serializes in insertion order; choose canonical order explicitly.
  return new CompactSign(encoder.encode(canonical(delivery)))
    .setProtectedHeader(JSON.parse(canonical(header)))
    .sign(key);
}

export async function verifyDelivery(
  message: string,
  options: {
    issuer: string;
    audience: string;
    kid: string;
    key: CryptoKey;
    now: number;
    consumeNonce: (nonce: string, retainUntil: number) => Promise<boolean>;
  },
) {
  if (encoder.encode(message).length > MAX_MESSAGE_BYTES) throw new Error('MESSAGE_SIZE');

  const segments = message.split('.');
  if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
    throw new Error('JWS_STRUCTURE');

  parseCanonical(decoder.decode(base64url.decode(segments[0])));
  const header = decodeProtectedHeader(message);
  if (
    header.alg !== 'EdDSA' ||
    header.kid !== options.kid ||
    header.typ !== DELIVERY_TYPE ||
    Object.keys(header).sort().join(',') !== 'alg,kid,typ'
  )
    throw new Error('JWS_HEADER');

  const { payload } = await compactVerify(message, options.key, {
    algorithms: ['EdDSA'],
  });
  const value = parseCanonical(decoder.decode(payload));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('DELIVERY_SCHEMA');

  const d = value as Delivery;
  const fields =
    'audience,body,bodyHash,expiresAt,issuedAt,issuer,messageType,method,nonce,path,protocolVersion';
  if (
    Object.keys(d).sort().join(',') !== fields ||
    d.protocolVersion !== 1 ||
    d.messageType !== 'probe' ||
    d.method !== 'POST' ||
    d.path !== INBOX_PATH ||
    typeof d.nonce !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(d.nonce) ||
    typeof d.bodyHash !== 'string'
  )
    throw new Error('DELIVERY_SCHEMA');

  if (
    origin(d.issuer) !== origin(options.issuer) ||
    origin(d.audience) !== origin(options.audience)
  )
    throw new Error('DELIVERY_TARGET');

  if (
    !Number.isSafeInteger(d.issuedAt) ||
    !Number.isSafeInteger(d.expiresAt) ||
    d.expiresAt <= d.issuedAt ||
    d.expiresAt - d.issuedAt > DELIVERY_TTL ||
    d.issuedAt > options.now + CLOCK_SKEW ||
    options.now >= d.expiresAt + CLOCK_SKEW
  )
    throw new Error('DELIVERY_TIME');

  if ((await bodyHash(d.body)) !== d.bodyHash) throw new Error('BODY_HASH');
  if (!(await options.consumeNonce(d.nonce, d.expiresAt + CLOCK_SKEW)))
    throw new Error('REPLAY');

  return d;
}

// 0B probe only: no production inbox or event authorization is exposed.
export async function signatureProbe() {
  const keys = await generateKeyPair('EdDSA', { extractable: true });
  const now = Math.floor(Date.now() / 1000);
  const body = { check: 'workers-ed25519', values: [1, 2, 3] };
  const delivery: Delivery = {
    protocolVersion: 1,
    messageType: 'probe',
    issuer: 'https://a.example',
    audience: 'https://b.example',
    issuedAt: now,
    expiresAt: now + DELIVERY_TTL,
    nonce: crypto.randomUUID(),
    method: 'POST',
    path: INBOX_PATH,
    bodyHash: await bodyHash(body),
    body,
  };

  const message = await signDelivery(delivery, keys.privateKey, 'probe');

  await verifyDelivery(message, {
    issuer: delivery.issuer,
    audience: delivery.audience,
    kid: 'probe',
    key: keys.publicKey,
    now,
    consumeNonce: async () => true,
  });

  return { verified: true, message, publicKey: await exportJWK(keys.publicKey) };
}
