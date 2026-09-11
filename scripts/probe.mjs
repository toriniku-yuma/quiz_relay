import assert from 'node:assert/strict';
import { importJWK } from 'jose';
import { API_PATHS } from '../src/shared/api-paths.ts';
import { verifyDelivery } from '../src/worker/federation/signatures.ts';

const origin = process.env.PROBE_ORIGIN || 'http://127.0.0.1:5173';
const target = new URL(origin);
const [first, second] = target.hostname.split('.').map(Number);
const isTailnetIp = first === 100 && second >= 64 && second <= 127;

assert(
  target.origin === origin &&
    (target.protocol === 'https:' ||
      (target.protocol === 'http:' && (target.hostname === '127.0.0.1' || isTailnetIp))),
  'Use HTTPS, loopback, or a Tailscale IP',
);
assert(process.env.PROBE_TOKEN?.length >= 32, 'Set PROBE_TOKEN in .dev.vars');

async function request(path, method = 'GET') {
  const response = await fetch(origin + path, {
    method,
    redirect: 'error',
    headers: { Authorization: `Bearer ${process.env.PROBE_TOKEN}` },
  });
  assert(response.ok, `Probe returned HTTP ${response.status}`);

  return response.json();
}

assert.equal((await request(API_PATHS.health)).ok, true);

const before = await request(API_PATHS.durableObject);

await request(API_PATHS.durableObject, 'POST');
const after = await request(API_PATHS.durableObject);

assert.equal(after.count, before.count + 1);

await new Promise((resolve) => setTimeout(resolve, 6000));
const alarm = await request(API_PATHS.durableObject);
assert.equal(alarm.deadline, null);
assert.equal(typeof alarm.firedAt, 'number');

const signature = await request(API_PATHS.signature, 'POST');
const key = await importJWK(signature.publicKey, 'EdDSA');

await verifyDelivery(signature.message, {
  issuer: 'https://a.example',
  audience: 'https://b.example',
  kid: 'probe',
  key,
  now: Math.floor(Date.now() / 1000),
  consumeNonce: async () => true,
});

const status = await request(API_PATHS.status);
if (status.databaseConfigured) {
  const database = await request(API_PATHS.database, 'POST');
  assert.equal(database.committed, true);
  assert.equal(database.rolledBack, true);
}

console.log(
  JSON.stringify(
    {
      health: 'PASS',
      persistence: 'PASS',
      alarm: 'PASS',
      workersToNodeSignature: 'PASS',
      database: status.databaseConfigured ? 'PASS' : 'NOT_CONFIGURED',
      auth: 'MANUAL_CHECK_REQUIRED',
    },
    null,
    2,
  ),
);
