import { base64url, CompactSign, generateKeyPair, importJWK } from 'jose';
import { beforeAll, expect, it } from 'vitest';
import { peerRequest, rejectRedirect } from '../src/worker/federation/egress';
import {
  bodyHash,
  canonical,
  DELIVERY_TYPE,
  type Delivery,
  INBOX_PATH,
  parseCanonical,
  signDelivery,
  verifyDelivery,
} from '../src/worker/federation/signatures';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let delivery: Delivery;

beforeAll(async () => {
  keys = await generateKeyPair('EdDSA');
  delivery = {
    protocolVersion: 1,
    messageType: 'probe',
    issuer: 'https://a.example',
    audience: 'https://b.example',
    issuedAt: 1000,
    expiresAt: 1060,
    nonce: crypto.randomUUID(),
    method: 'POST',
    path: INBOX_PATH,
    bodyHash: await bodyHash({ a: 1, b: 2 }),
    body: { b: 2, a: 1 },
  };
});

function options() {
  return {
    issuer: delivery.issuer,
    audience: delivery.audience,
    kid: 'key-1',
    key: keys.publicKey,
    now: 1000,
    consumeNonce: async () => true,
  };
}

it('canonicalizes property order and rejects duplicate keys, lone surrogates and non-finite numbers', async () => {
  expect(canonical({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  expect(await bodyHash({ b: 2, a: 1 })).toBe(await bodyHash({ a: 1, b: 2 }));
  expect(() => parseCanonical('{"a":1,"a":2}')).toThrow();
  expect(() => canonical('\ud800')).toThrow();
  expect(() => canonical(Infinity)).toThrow();
  expect(() => canonical(undefined)).toThrow();
  expect(canonical('😀')).toBe('"😀"');
});

it('round-trips Ed25519 in Workers and consumes a nonce once', async () => {
  const seen = new Set<string>();
  const config = {
    ...options(),
    consumeNonce: async (nonce: string) => {
      if (seen.has(nonce)) return false;
      seen.add(nonce);

      return true;
    },
  };

  const message = await signDelivery(delivery, keys.privateKey, 'key-1');

  expect(await verifyDelivery(message, config)).toEqual(delivery);

  await expect(verifyDelivery(message, config)).rejects.toThrow('REPLAY');
});

it.each([
  ['audience', 'https://other.example'],
  ['issuer', 'https://evil.example'],
  ['messageType', 'result.finalized'],
  ['protocolVersion', 2],
  ['method', 'GET'],
  ['path', '/federation/v1/question-set-export'],
  ['bodyHash', 'wrong'],
  ['expiresAt', 1061],
  ['issuedAt', 1010],
  ['expiresAt', 900],
  ['nonce', 'short'],
])('rejects signed invalid %s = %s before consuming nonce', async (field, value) => {
  let consumed = false;

  const message = await signDelivery(
    { ...delivery, [field]: value },
    keys.privateKey,
    'key-1',
  );

  await expect(
    verifyDelivery(message, {
      ...options(),
      consumeNonce: async () => {
        consumed = true;

        return true;
      },
    }),
  ).rejects.toThrow();
  expect(consumed).toBe(false);
});

it('checks expiry boundary, pinned key and kid, tampering, and size', async () => {
  const message = await signDelivery(delivery, keys.privateKey, 'key-1');

  await expect(
    verifyDelivery(message, { ...options(), now: 1064 }),
  ).resolves.toBeDefined();

  await expect(verifyDelivery(message, { ...options(), now: 1065 })).rejects.toThrow(
    'DELIVERY_TIME',
  );

  await expect(verifyDelivery(message, { ...options(), kid: 'unknown' })).rejects.toThrow(
    'JWS_HEADER',
  );

  const wrongKeys = await generateKeyPair('EdDSA');

  await expect(
    verifyDelivery(message, { ...options(), key: wrongKeys.publicKey }),
  ).rejects.toThrow();

  const parts = message.split('.');
  parts[1] = base64url.encode(
    new TextEncoder().encode(canonical({ ...delivery, body: { a: 9 } })),
  );

  await expect(verifyDelivery(parts.join('.'), options())).rejects.toThrow();

  await expect(verifyDelivery('a'.repeat(256 * 1024 + 1), options())).rejects.toThrow(
    'MESSAGE_SIZE',
  );
});

it('rejects duplicate payload keys and ticket purpose even when signed', async () => {
  const duplicated = canonical(delivery).replace(
    '"protocolVersion":1',
    '"protocolVersion":1,"protocolVersion":1',
  );

  for (const [payload, typ] of [
    [duplicated, DELIVERY_TYPE],
    [canonical(delivery), 'quiz-relay-ticket+jwt'],
  ]) {
    const message = await new CompactSign(new TextEncoder().encode(payload))
      .setProtectedHeader({ alg: 'EdDSA', kid: 'key-1', typ })
      .sign(keys.privateKey);
    await expect(verifyDelivery(message, options())).rejects.toThrow();
  }
});

it.each([
  'http://a.example',
  'https://127.0.0.1',
  'https://2130706433',
  'https://[::1]',
  'https://169.254.169.254',
  'https://10.0.0.1',
  'https://localhost',
  'https://x.local',
  'https://a.example/path',
  'https://a.example?x=1',
  'https://user:pass@a.example',
])('rejects unsupported destination %s', (target) => {
  expect(() => peerRequest(target, [target], INBOX_PATH, 'test')).toThrow();
});

it('pins the approved origin and fixed path and disables redirects', () => {
  const target = 'https://peer.account.workers.dev';

  expect(() => peerRequest(target, [], INBOX_PATH, 'test')).toThrow('UNAPPROVED_PEER');
  expect(() => peerRequest(target, [target], '//evil.example', 'test')).toThrow(
    'DESTINATION_PATH',
  );

  const request = peerRequest(target, [target], INBOX_PATH, 'test');

  expect(request.url).toBe(target + INBOX_PATH);
  expect(request.redirect).toBe('manual');
  expect(() =>
    rejectRedirect(
      new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }),
    ),
  ).toThrow('REDIRECT_REJECTED');
});

it('verifies an independently Node-signed public fixture inside Workers', async () => {
  const { default: fixture } = await import('./fixtures/node-signature.json');
  const key = (await importJWK(fixture.publicKey, 'EdDSA')) as CryptoKey;

  const verified = await verifyDelivery(fixture.message, {
    issuer: 'https://node.example',
    audience: 'https://workers.example',
    kid: 'node-fixture',
    key,
    now: 1000,
    consumeNonce: async () => true,
  });

  expect(verified.body).toMatchObject({ source: 'Node.js', value: 'カタカナ' });
});

it.each([
  'https://peer.example',
  'https://peer.account.workers.dev.evil.example',
  'https://peer.account.workers.dev:8443',
  'https://preview.peer.account.workers.dev',
])('rejects destinations outside the workers.dev profile: %s', (target) => {
  expect(() => peerRequest(target, [target], INBOX_PATH, 'test')).toThrow(
    'DESTINATION_PROFILE',
  );
});
