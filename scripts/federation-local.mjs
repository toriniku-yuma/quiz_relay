import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readD1Migrations } from '@cloudflare/vitest-plugin';

const minutes = Number(process.argv[2]);
assert(minutes > 0 && minutes <= 30, 'Specify a duration in (0, 30] minutes');
for (const flag of process.argv.slice(3))
  assert(
    [
      '--disconnect-host',
      '--disconnect-boundaries',
      '--disconnect-lobbies',
      '--ranked-only',
      '--rooms-only',
      '--unapproved',
    ].includes(flag),
    `Unknown local load option: ${flag}`,
  );
const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire('miniflare');
const { build } = runtimeRequire('esbuild');
const gameConfig = JSON.parse(
  await readFile('config/federation/wrangler.game.jsonc', 'utf8'),
);
const erasureConfig = JSON.parse(
  await readFile('config/federation/wrangler.erasure.jsonc', 'utf8'),
);
const directory = resolve(`.wrangler/qa/federation-local-${crypto.randomUUID()}`);
await mkdir(directory, { recursive: true });
// SQLite flushes must not contend with source/build IO on the project drive.
const stateDirectory = await mkdtemp(join(tmpdir(), 'quiz-relay-federation-'));
const origins = Object.fromEntries(
  ['a', 'b'].map((side) => [side, gameConfig.env[side].vars.FEDERATION_ORIGIN]),
);
const keys = Object.fromEntries(
  ['a', 'b'].map((side) => [
    side,
    generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }),
  ]),
);
const tokens = Object.fromEntries(
  ['a', 'b'].map((side) => [side, randomBytes(32).toString('hex')]),
);
for (const [kind, entry] of [
  ['game', 'scripts/federation-game-worker.ts'],
  ['erasure', 'src/erasure/index.ts'],
])
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'],
    define: { 'import.meta.env.DEV': 'false' },
    outfile: `${directory}/${kind}.mjs`,
    sourcemap: 'linked',
  });

// This router is the only outbound service. Unknown destinations never reach the network.
const router = `export default { async fetch(request, env) {
  let url = new URL(request.url);
  const origins = ${JSON.stringify(origins)};
  if (url.hostname === '127.0.0.1') {
    const side = url.pathname.split('/')[1];
    if (!Object.hasOwn(origins, side)) return new Response('LOCAL_ROUTE_REJECTED', { status: 403 });
    url = new URL(url.pathname.slice(2) + url.search, origins[side]);
  }
  const side = Object.keys(origins).find(side => origins[side] === url.origin);
  if (!side) return new Response('LOCAL_EGRESS_REJECTED', { status: 403 });
  return env[side].fetch(new Request(url, request));
} }`;
const workers = [
  {
    name: 'router',
    modules: true,
    script: router,
    compatibilityDate: gameConfig.compatibility_date,
    serviceBindings: { a: gameConfig.env.a.name, b: gameConfig.env.b.name },
    outboundService: () => new Response('LOCAL_EGRESS_REJECTED', { status: 403 }),
  },
];
for (const side of ['a', 'b']) {
  const peer = side === 'a' ? 'b' : 'a';
  for (const [kind, config] of [
    ['game', gameConfig],
    ['erasure', erasureConfig],
  ]) {
    const settings = config.env[side];
    workers.push({
      name: settings.name,
      modules: true,
      scriptPath: `${directory}/${kind}.mjs`,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      bindings: {
        ...settings.vars,
        SIGNING_PRIVATE_KEY: keys[side].privateKey,
        PEER_PUBLIC_KEY: keys[peer].publicKey,
        TEST_ADMIN_SUBJECT: `local-admin-${side}`,
        PROBE_TOKEN: tokens[side],
      },
      d1Databases: { GAME_D1: `local-${side}` },
      durableObjects: Object.fromEntries(
        settings.durable_objects.bindings.map((binding) => [
          binding.name,
          {
            className: binding.class_name,
            useSQLite: true,
            ...(binding.script_name ? { scriptName: binding.script_name } : {}),
          },
        ]),
      ),
      serviceBindings: Object.fromEntries(
        settings.services.map((binding) => [binding.binding, binding.service]),
      ),
      ratelimits: Object.fromEntries(
        settings.ratelimits.map((binding) => [
          binding.name,
          {
            namespace_id: binding.namespace_id,
            simple: binding.simple,
          },
        ]),
      ),
      outboundService: 'router',
    });
  }
}
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    host: '127.0.0.1',
    port: 0,
    workers,
    resourcePersistencePath: stateDirectory,
  }),
);
let child;
let stage = 'runtime';
process.on('SIGINT', () => child?.kill('SIGINT'));
try {
  const address = await runtime.ready;
  const endpoints = Object.fromEntries(
    ['a', 'b'].map((side) => [side, `${address.origin}/${side}`]),
  );
  const runtimeFile = `${directory}/runtime.json`;
  await writeFile(runtimeFile, JSON.stringify({ endpoints, tokens }));
  const gateway = await runtime.getWorker('router');
  stage = 'egress isolation';
  assert.equal(
    (await gateway.fetch('https://outside.invalid/')).status,
    403,
    'local egress must be closed',
  );
  assert.equal(
    (await fetch(`${endpoints.a}/api/probes/game/status`)).status,
    401,
    'local probes must require authentication',
  );
  // Each run owns fresh, isolated databases; application migrations are used unchanged.
  const migrations = await readD1Migrations('drizzle-d1');
  for (const side of ['a', 'b']) {
    stage = `database ${side}`;
    const database = await runtime.getD1Database('GAME_D1', gameConfig.env[side].name);
    for (const migration of migrations)
      await database.batch(migration.queries.map((query) => database.prepare(query)));
  }
  const api = async (side, path, body) => {
    stage = `${side}/${path}`;
    // Miniflare's dispatcher manages setup connections across service bindings.
    const response = await gateway.fetch(`${origins[side]}/api/probes/game/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${tokens[side]}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, `${side}/${path}: ${result.code}`);
    return result;
  };
  const instances = {};
  for (const side of ['a', 'b']) {
    await api(side, 'bootstrap', { confirmation: '新規検証環境' });
    instances[side] = (await api(side, 'status')).instances;
    for (const instance of instances[side])
      await api(side, 'setup', { instanceId: instance.id });
    await api(side, 'peer', {});
  }
  for (const side of ['a', 'b'])
    for (const instance of instances[side])
      await api(side, 'sync', { instanceId: instance.id });
  // A removed match/session is an authentication rejection, not a server failure.
  stage = 'expired-session';
  const expiredSession = await gateway.fetch(
    `${origins.a}/api/probes/game/load/socket?${new URLSearchParams({ runId: crypto.randomUUID(), index: '0', room: crypto.randomUUID() })}`,
    { headers: { Authorization: `Bearer ${tokens.a}`, 'X-QA-Session': 'expired' } },
  );
  assert.equal(expiredSession.status, 401);
  assert.equal((await expiredSession.json()).code, 'SESSION_REQUIRED');
  console.log(
    JSON.stringify({
      event: 'local_ready',
      directory,
      stateDirectory,
      network: 'loopback only',
      minutes,
    }),
  );
  child = spawn(
    process.execPath,
    [
      'scripts/federation-load.mjs',
      String(minutes),
      ...process.argv.slice(3),
      '--local-runtime',
      runtimeFile,
    ],
    { stdio: 'inherit' },
  );
  const [code, signal] = await once(child, 'exit');
  process.exitCode = code === 0 && !signal ? 0 : 1;
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'local_setup_failed',
      stage,
      name: error.name,
      code: error.cause?.code,
    }),
  );
  process.exitCode = 1;
} finally {
  await runtime.dispose();
}
