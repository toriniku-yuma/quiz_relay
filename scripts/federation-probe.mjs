import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, importPKCS8 } from 'jose';
import { API_PATHS } from '../src/shared/api-paths.ts';
import {
  bodyHash,
  INBOX_PATH,
  signDelivery,
} from '../src/worker/federation/signatures.ts';

const root = new URL('../', import.meta.url);
const config = JSON.parse(
  await readFile(new URL('config/federation/wrangler.jsonc', root), 'utf8'),
);
const nodes = [];
for (const name of ['a', 'b']) {
  const vars = config.env[name].vars;
  const secrets = JSON.parse(
    await readFile(new URL(`.wrangler/federation-${name}-secrets.json`, root), 'utf8'),
  );
  const origin = new URL(vars.GAME_OWNER);
  assert.equal(origin.origin, vars.GAME_OWNER);
  assert.equal(origin.protocol, 'https:');
  assert.equal(
    origin.hostname,
    `quiz-relay-federation-${name}-test.quiz-relay.workers.dev`,
  );
  assert(secrets.PROBE_TOKEN?.length >= 32, 'Missing private probe configuration');
  nodes.push({ vars, secrets });
}
const [a, b] = nodes;
assert.notEqual(a.secrets.PROBE_TOKEN, b.secrets.PROBE_TOKEN);
assert.notEqual(a.secrets.CLERK_PUBLISHABLE_KEY, b.secrets.CLERK_PUBLISHABLE_KEY);

async function request(
  node,
  path,
  { method = 'GET', body, authenticated = true, headers = {} } = {},
) {
  const response = await fetch(node.vars.GAME_OWNER + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${node.secrets.PROBE_TOKEN}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}
async function fault(node, mode) {
  assert.equal(
    (await request(node, '/api/probes/fault', { method: 'POST', body: { mode } })).status,
    200,
  );
}
async function run(node) {
  const result = await request(node, '/api/probes/run', { method: 'POST' });
  assert.equal(result.status, 200, `Signed delivery failed: ${result.body.code}`);
  for (const key of ['reached', 'signed', 'd1', 'replayRejected'])
    assert.equal(result.body[key], true);
  assert(result.body.peerRowsWritten > 0);
  return result.body;
}

if (process.argv.slice(2).includes('--setup')) {
  for (const node of nodes) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await request(node, '/api/probes/database/setup', {
        method: 'POST',
      });
      assert.equal(result.status, 200, `Test setup failed: ${result.body.code}`);
      assert.equal(result.body.organizations, 1);
      assert.equal(result.body.instances, 2);
      assert.equal(result.body.gameReady, false);
    }
    console.log(
      JSON.stringify({
        node: node.vars.TEST_NODE,
        organizations: 1,
        instances: 2,
        idempotentSetup: true,
      }),
    );
  }
}

for (const node of nodes) {
  const health = await request(node, API_PATHS.health, { authenticated: false });
  assert.equal(health.status, 200);
  assert.equal(health.body.node, node.vars.TEST_NODE);
  assert.equal(health.body.gameReady, false);
  const auth = await request(node, API_PATHS.authConfig, { authenticated: false });
  assert.equal(auth.status, 200);
  assert.equal(auth.body.provider, 'clerk');
  assert(!JSON.stringify(auth.body).includes('sk_test_'));
  assert.equal(
    (await request(node, API_PATHS.authIdentity, { authenticated: false })).status,
    401,
  );
  assert.equal(
    (await request(node, '/api/probes/run', { method: 'POST', authenticated: false }))
      .status,
    401,
  );
  assert.equal(
    (
      await request(node, '/api/probes/run', {
        method: 'POST',
        headers: { Origin: node.vars.PEER_ORIGIN },
      })
    ).status,
    403,
  );
}

const report = { independentAuth: true, controlsProtected: true, gameReady: false };
try {
  await fault(a, 'normal');
  await fault(b, 'normal');
  report.aToB = await run(a);
  report.bToA = await run(b);
  const before = (await request(b, '/api/probes/status')).body.probeRows;
  const now = Math.floor(Date.now() / 1000);
  const body = { check: 'external-rejection' };
  const delivery = {
    protocolVersion: 1,
    messageType: 'probe',
    issuer: a.vars.GAME_OWNER,
    audience: b.vars.GAME_OWNER,
    issuedAt: now,
    expiresAt: now + 60,
    nonce: crypto.randomUUID(),
    method: 'POST',
    path: INBOX_PATH,
    bodyHash: await bodyHash(body),
    body,
  };
  const key = await importPKCS8(a.secrets.SIGNING_PRIVATE_KEY, 'EdDSA');
  const other = await generateKeyPair('EdDSA');
  for (const [record, signingKey] of [
    [delivery, other.privateKey],
    [{ ...delivery, audience: a.vars.GAME_OWNER }, key],
    [{ ...delivery, issuedAt: now - 120, expiresAt: now - 60 }, key],
  ]) {
    const message = await signDelivery(record, signingKey, a.vars.SIGNING_KID);
    assert.equal(
      (
        await request(b, INBOX_PATH, {
          method: 'POST',
          body: { message },
          authenticated: false,
        })
      ).status,
      401,
    );
  }
  assert.equal((await request(b, '/api/probes/status')).body.probeRows, before);
  report.invalidSignatureTargetExpiryRejected = true;
  for (const [mode, code] of [
    ['unavailable', 'PEER_UNAVAILABLE'],
    ['redirect', 'REDIRECT_REJECTED'],
    ['timeout', 'PEER_TIMEOUT'],
  ]) {
    await fault(b, mode);
    const result = await request(a, '/api/probes/run', { method: 'POST' });
    assert.equal(result.status, 502);
    assert.equal(result.body.code, code);
  }
  report.failureModes = ['unavailable', 'redirect', 'timeout'];
} finally {
  await fault(a, 'normal');
  await fault(b, 'normal');
}
report.recovery = await run(a);
console.log(
  JSON.stringify(
    {
      ...report,
      secretValuesDisplayed: false,
      config: fileURLToPath(new URL('config/federation/wrangler.jsonc', root)),
    },
    null,
    2,
  ),
);
