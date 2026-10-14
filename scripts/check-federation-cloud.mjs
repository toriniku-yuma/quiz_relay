import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { importPKCS8, importSPKI } from 'jose';
import { API_PATHS } from '../src/shared/api-paths.ts';
import { QUESTION_SYNC_FRESH_MS } from '../src/shared/federation-questions.ts';
import {
  bodyHash,
  canonical,
  MAX_MESSAGE_BYTES,
  signDelivery,
  verifyDelivery,
} from '../src/worker/federation/signatures.ts';

const root = new URL('../', import.meta.url);
const checks = [];
let phase = 'configuration';
const report = { passed: false, checkedAt: new Date().toISOString(), checks };
const configOnly = process.argv.slice(2).includes('--config-only');
assert(
  process.argv.slice(2).every((arg) => arg === '--config-only'),
  'UNKNOWN_OPTION',
);

async function check(name, action) {
  phase = name;
  const started = performance.now();
  const result = await action();
  checks.push({ name, passed: true, elapsedMs: Math.round(performance.now() - started) });
  return result;
}
async function request(node, path, options = {}) {
  const response = await fetch(node.vars.FEDERATION_ORIGIN + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    ...options,
  });
  const text = await response.text();
  assert(Buffer.byteLength(text) <= MAX_MESSAGE_BYTES, 'RESPONSE_TOO_LARGE');
  return { status: response.status, body: JSON.parse(text) };
}
async function envelope(sender, receiver, path, messageType, body, changes = {}) {
  const now = Math.floor(Date.now() / 1000);
  const delivery = {
    protocolVersion: 1,
    messageType,
    issuer: sender.vars.FEDERATION_ORIGIN,
    audience: receiver.vars.FEDERATION_ORIGIN,
    issuedAt: now,
    expiresAt: now + 60,
    nonce: crypto.randomUUID(),
    method: 'POST',
    path,
    bodyHash: await bodyHash(body),
    body,
    ...changes,
  };
  return {
    delivery,
    message: await signDelivery(delivery, sender.key, sender.vars.SIGNING_KID),
  };
}
const post = (receiver, path, message) =>
  request(receiver, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: canonical({ message }),
  });
async function signedRequest(sender, receiver, path, requestType, responseType, body) {
  const sent = await envelope(sender, receiver, path, requestType, body);
  const response = await post(receiver, path, sent.message);
  assert.equal(response.status, 200, 'SIGNED_REQUEST_FAILED');
  assert(Object.keys(response.body).join(',') === 'message', 'INVALID_RESPONSE_ENVELOPE');
  const seen = new Set();
  const received = await verifyDelivery(response.body.message, {
    issuer: receiver.vars.FEDERATION_ORIGIN,
    audience: sender.vars.FEDERATION_ORIGIN,
    kid: receiver.vars.SIGNING_KID,
    key: await importSPKI(sender.secrets.PEER_PUBLIC_KEY, 'EdDSA'),
    now: Math.floor(Date.now() / 1000),
    messageType: responseType,
    path,
    replyTo: sent.delivery.nonce,
    consumeNonce: async (nonce) => {
      if (seen.has(nonce)) return false;
      seen.add(nonce);
      return true;
    },
  });
  return { sent, body: received.body };
}
async function main() {
  const config = JSON.parse(
    await readFile(new URL('config/federation/wrangler.game.jsonc', root), 'utf8'),
  );
  const privateConfig = JSON.parse(
    await readFile(new URL('config/federation/wrangler.erasure.jsonc', root), 'utf8'),
  );
  const nodes = await check('A/B bindings and private service', async () => {
    assert(config.main === '../../scripts/federation-game-worker.ts', 'WRONG_ENTRY');
    assert(
      privateConfig.workers_dev === false &&
        privateConfig.preview_urls === false &&
        privateConfig.routes.length === 0,
      'PRIVATE_SERVICE_EXPOSED',
    );
    const result = ['a', 'b'].map((name) => {
      const node = config.env[name],
        privateNode = privateConfig.env[name];
      assert(
        (privateNode.workers_dev ?? privateConfig.workers_dev) === false &&
          (privateNode.preview_urls ?? privateConfig.preview_urls) === false &&
          (privateNode.routes ?? privateConfig.routes).length === 0,
        'PRIVATE_SERVICE_EXPOSED',
      );
      const expected = `https://quiz-relay-federation-${name}-test.quiz-relay.workers.dev`;
      assert(
        node.vars.FEDERATION_ORIGIN === expected && node.vars.PROBES_ENABLED === 'true',
        'QA_TARGET_MISMATCH',
      );
      assert(
        node.services.find((service) => service.binding === 'ACCOUNT_ERASURE')
          ?.service === privateNode.name,
        'SERVICE_MISMATCH',
      );
      assert(
        node.d1_databases[0].database_id === privateNode.d1_databases[0].database_id,
        'D1_MISMATCH',
      );
      assert(
        privateNode.durable_objects.bindings.every(
          (binding) => binding.script_name === node.name,
        ),
        'DO_MISMATCH',
      );
      assert(node.triggers.crons.includes('* * * * *'), 'CRON_MISSING');
      return { name, vars: node.vars, databaseId: node.d1_databases[0].database_id };
    });
    assert(
      result[0].databaseId !== result[1].databaseId &&
        result[0].vars.PEER_ORIGIN === result[1].vars.FEDERATION_ORIGIN &&
        result[1].vars.PEER_ORIGIN === result[0].vars.FEDERATION_ORIGIN,
      'A/B_NOT_ISOLATED',
    );
    return result;
  });
  if (configOnly) return;
  await check('independent credentials and matching peer keys', async () => {
    for (const node of nodes) {
      node.secrets = JSON.parse(
        await readFile(
          new URL(`.wrangler/federation-${node.name}-secrets.json`, root),
          'utf8',
        ),
      );
      for (const field of [
        'PROBE_TOKEN',
        'SIGNING_PRIVATE_KEY',
        'PEER_PUBLIC_KEY',
        'CLERK_PUBLISHABLE_KEY',
        'CLERK_SECRET_KEY',
        'TEST_ADMIN_SUBJECT',
      ])
        assert(
          typeof node.secrets[field] === 'string' && node.secrets[field].length > 0,
          'SECRET_MISSING',
        );
      assert(node.secrets.PROBE_TOKEN.length >= 32, 'PROBE_TOKEN_TOO_SHORT');
      node.key = await importPKCS8(node.secrets.SIGNING_PRIVATE_KEY, 'EdDSA', {
        extractable: true,
      });
    }
    const [a, b] = nodes;
    assert(
      a.secrets.PROBE_TOKEN !== b.secrets.PROBE_TOKEN &&
        a.secrets.SIGNING_PRIVATE_KEY !== b.secrets.SIGNING_PRIVATE_KEY &&
        a.secrets.CLERK_PUBLISHABLE_KEY !== b.secrets.CLERK_PUBLISHABLE_KEY,
      'SHARED_CREDENTIALS',
    );
    assert(
      createPublicKey(a.secrets.SIGNING_PRIVATE_KEY)
        .export({ type: 'spki', format: 'pem' })
        .trim() === b.secrets.PEER_PUBLIC_KEY.trim() &&
        createPublicKey(b.secrets.SIGNING_PRIVATE_KEY)
          .export({ type: 'spki', format: 'pem' })
          .trim() === a.secrets.PEER_PUBLIC_KEY.trim(),
      'PEER_KEY_MISMATCH',
    );
  });
  for (const node of nodes) {
    const prefix = node.name.toUpperCase();
    await check(
      `${prefix} health, page routing, Clerk and unauthenticated rejection`,
      async () => {
        const health = await request(node, API_PATHS.health);
        assert(health.status === 200 && health.body.ok === true, 'HEALTH_FAILED');
        const page = await fetch(`${node.vars.FEDERATION_ORIGIN}/federation/`, {
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        });
        assert(
          page.status === 200 &&
            page.headers.get('content-type')?.startsWith('text/html') &&
            (await page.text()).includes('<div id="root"></div>'),
          'FEDERATION_PAGE_ROUTING_FAILED',
        );
        const auth = await request(node, API_PATHS.publicAuthConfig);
        assert(
          auth.status === 200 &&
            Object.keys(auth.body).join() === 'publishableKey' &&
            auth.body.publishableKey === node.secrets.CLERK_PUBLISHABLE_KEY,
          'AUTH_CONFIG_MISMATCH',
        );
        assert.equal(
          (await request(node, API_PATHS.authIdentity)).status,
          401,
          'AUTH_BYPASS',
        );
        assert.equal(
          (await request(node, '/api/probes/game/status')).status,
          401,
          'QA_BYPASS',
        );
      },
    );
    await check(`${prefix} protected readiness and scheduled freshness`, async () => {
      const status = await request(node, '/api/probes/game/status', {
        headers: { Authorization: `Bearer ${node.secrets.PROBE_TOKEN}` },
      });
      assert(
        status.status === 200 &&
          status.body.gameReady === true &&
          status.body.node === prefix,
        'QA_NOT_READY',
      );
      assert(
        status.body.instances.length === 2 &&
          status.body.instances.every((instance) => instance.state === 'published'),
        'INSTANCES_NOT_READY',
      );
      node.instance = status.body.instances.find(
        (instance) => instance.name === `${prefix}-1`,
      ).id;
      const enabled = status.body.imports.filter((row) => row.enabled);
      report.synchronization ??= [];
      report.synchronization.push({
        node: prefix,
        metadataSuccessAt: Math.min(
          ...status.body.metadata
            .filter((row) => row.peerOrigin === node.vars.PEER_ORIGIN)
            .map((row) => row.lastSuccessAt),
        ),
        questionsSuccessAt: enabled.length
          ? Math.min(...enabled.map((row) => row.lastSuccessAt))
          : null,
        questionErrors: enabled.map((row) => row.errorCode).filter(Boolean),
      });
      for (const instance of status.body.instances) {
        const metadata = status.body.metadata.find(
          (row) =>
            row.instanceId === instance.id && row.peerOrigin === node.vars.PEER_ORIGIN,
        );
        assert(
          metadata && !metadata.errorCode && Date.now() - metadata.lastSuccessAt < 90000,
          'METADATA_STALE',
        );
      }
      assert(
        enabled.every(
          (row) =>
            !row.errorCode && Date.now() - row.lastSuccessAt < QUESTION_SYNC_FRESH_MS,
        ),
        'QUESTION_IMPORT_STALE',
      );
      node.importCount = enabled.length;
    });
  }
  for (const [sender, receiver] of [nodes, [...nodes].reverse()]) {
    const label = `${sender.name.toUpperCase()} -> ${receiver.name.toUpperCase()}`;
    const path = '/federation/v1/metadata';
    const body = { sourceInstanceId: sender.instance };
    const received = await check(
      `${label} signed metadata and response binding`,
      async () => {
        const result = await signedRequest(
          sender,
          receiver,
          path,
          'metadata.request',
          'metadata.response',
          body,
        );
        assert(
          result.body.sourceInstanceId === sender.instance &&
            result.body.instances.length === 2 &&
            result.body.nextCursor === null,
          'METADATA_MISMATCH',
        );
        return result;
      },
    );
    await check(`${label} replay, signature, audience and expiry rejection`, async () => {
      const replay = await post(receiver, path, received.sent.message);
      assert(
        replay.status === 409 && replay.body.code === 'FEDERATION_REPLAY',
        'REPLAY_ACCEPTED',
      );
      const parts = received.sent.message.split('.');
      parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
      assert.equal(
        (await post(receiver, path, parts.join('.'))).status,
        401,
        'BAD_SIGNATURE_ACCEPTED',
      );
      for (const changes of [
        { audience: sender.vars.FEDERATION_ORIGIN },
        {
          issuedAt: Math.floor(Date.now() / 1000) - 121,
          expiresAt: Math.floor(Date.now() / 1000) - 61,
        },
      ]) {
        const invalid = await envelope(
          sender,
          receiver,
          path,
          'metadata.request',
          body,
          changes,
        );
        assert.equal(
          (await post(receiver, path, invalid.message)).status,
          401,
          'INVALID_DELIVERY_ACCEPTED',
        );
      }
    });
    await check(`${label} signed shared-category catalog`, async () => {
      const catalog = await signedRequest(
        sender,
        receiver,
        API_PATHS.federationQuestionSync,
        'questions.request',
        'questions.response',
        {
          sourceInstanceId: receiver.instance,
          targetInstanceId: sender.instance,
          categoriesOnly: true,
        },
      );
      assert(
        catalog.body.sourceInstanceId === receiver.instance &&
          catalog.body.targetInstanceId === sender.instance &&
          catalog.body.categories.length > 0 &&
          catalog.body.questions.length === 0 &&
          catalog.body.nextCursor === null,
        'QUESTION_CATALOG_INVALID',
      );
    });
    await check(`${label} signed shared-question page`, async () => {
      const page = await signedRequest(
        sender,
        receiver,
        API_PATHS.federationQuestionSync,
        'questions.request',
        'questions.response',
        { sourceInstanceId: receiver.instance, targetInstanceId: sender.instance },
      );
      assert(
        page.body.sourceInstanceId === receiver.instance &&
          page.body.targetInstanceId === sender.instance &&
          page.body.questions.length > 0 &&
          page.body.questions.length <= 25,
        'QUESTION_PAGE_INVALID',
      );
      assert(
        page.body.questions.every(
          (question) => question.input.evidence === '共有元で確認済み',
        ),
        'PRIVATE_EVIDENCE_EXPORTED',
      );
    });
  }
  assert(
    nodes.some((node) => node.importCount > 0),
    'NO_ACTIVE_IMPORT',
  );
}
try {
  await main();
  report.passed = true;
} catch (error) {
  report.failure = phase;
  const code = error instanceof Error ? error.message.split('\n')[0] : '';
  report.errorCode = /^[A-Z_]+$/.test(code) ? code : 'CHECK_FAILED';
  process.exitCode = 1;
}
if (!configOnly) {
  await mkdir(new URL('.wrangler/qa/', root), { recursive: true });
  await writeFile(
    new URL('.wrangler/qa/federation-cloud-report.json', root),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
console.log(JSON.stringify(report, null, 2));
