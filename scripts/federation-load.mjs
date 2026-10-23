import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import { graphemes } from '../src/worker/game/questions.ts';
import { assertMatchResult } from './federation-result-check.mjs';
import { assertFreeBudget, cloudUsage } from './federation-usage.mjs';

// Reuse Wrangler's installed WebSocket client; no browser credentials are exported.
const require = createRequire(import.meta.url),
  WebSocket = createRequire(require.resolve('wrangler'))('ws');
const minutes = Number(process.argv[2] ?? 1);
const unapproved = process.argv.includes('--unapproved');
const disconnectLobbies = process.argv.includes('--disconnect-lobbies');
const rankedOnly = process.argv.includes('--ranked-only');
const roomsOnly = process.argv.includes('--rooms-only');
const disconnectHost = process.argv.includes('--disconnect-host');
const disconnectBoundaries = process.argv.includes('--disconnect-boundaries');
const localIndex = process.argv.indexOf('--local-runtime');
const local =
  localIndex < 0
    ? null
    : JSON.parse(await readFile(process.argv[localIndex + 1], 'utf8'));
const { connection } = JSON.parse(await readFile('config/runtime.json', 'utf8'));
assert(
  !roomsOnly || (!rankedOnly && !unapproved),
  'Room-only cannot test ranked or peer consent',
);
assert(!rankedOnly || !disconnectLobbies, 'Lobby disconnection requires the room test');
assert(
  !disconnectHost || (!rankedOnly && !disconnectLobbies),
  'Host disconnection requires a separate room test',
);
assert(minutes > 0 && minutes <= 30, 'Duration must be in (0, 30] minutes');
const runId = crypto.randomUUID(),
  origins = Object.fromEntries(
    ['a', 'b'].map((node) => [
      node,
      `https://quiz-relay-federation-${node}-test.quiz-relay.workers.dev`,
    ]),
  ),
  tokens = {};
for (const node of ['a', 'b']) {
  if (local) {
    const endpoint = new URL(local.endpoints[node]);
    assert.equal(endpoint.protocol, 'http:');
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.equal(endpoint.pathname, `/${node}`);
    assert(
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    );
    assert(typeof local.tokens[node] === 'string' && local.tokens[node].length >= 32);
    tokens[node] = local.tokens[node];
  } else
    tokens[node] = JSON.parse(
      await readFile(`.wrangler/federation-${node}-secrets.json`, 'utf8'),
    ).PROBE_TOKEN;
}
// Logical signed origins stay unchanged; only this explicit local transport is routed.
function transportUrl(value) {
  if (!local) return value;
  const url = new URL(value);
  const node = ['a', 'b'].find((side) => new URL(origins[side]).host === url.host);
  assert(node && ['https:', 'wss:'].includes(url.protocol), 'unknown local destination');
  const endpoint = `${local.endpoints[node]}${url.pathname}${url.search}`;
  return url.protocol === 'wss:' ? endpoint.replace('http:', 'ws:') : endpoint;
}
const request = async (url, init) => {
  const started = performance.now();
  try {
    return await fetch(transportUrl(url), init);
  } catch (error) {
    const knownCodes = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_ABORTED',
    ];
    const event = {
      event: 'http_transport_failed',
      at: new Date().toISOString(),
      path: new URL(url).pathname,
      method: init?.method ?? 'GET',
      elapsedMs: Math.round(performance.now() - started),
      errorType: ['Error', 'TypeError', 'TimeoutError', 'AbortError'].includes(error.name)
        ? error.name
        : undefined,
      code: knownCodes.includes(error.cause?.code) ? error.cause.code : undefined,
      causes: Array.isArray(error.cause?.errors)
        ? error.cause.errors
            .map((cause) => cause.code)
            .filter((code) => knownCodes.includes(code))
            .slice(0, 4)
        : [],
    };
    report.transportEvents.push(event);
    console.log(JSON.stringify(event));
    throw error;
  }
};
const questions = JSON.parse(await readFile('seeds/mock-hiragana.json', 'utf8')),
  report = {
    runId,
    startedAt: new Date().toISOString(),
    requestedMinutes: minutes,
    environment: local ? 'local' : 'cloud',
    scenario: rankedOnly
      ? 'two-player ranked only'
      : roomsOnly
        ? 'nine-player room only'
        : 'four-player ranked and nine-player room',
    auth: 'isolated QA fixture; normal signed federation/cookie/DO paths',
    foreignLogin: { logins: 0, joins: 0 },
    ranked: { games: 0, reconnects: 0, duplicates: 0, deliveries: [] },
    room: { games: 0, reconnects: 0, duplicates: 0, transportRecoveries: 0 },
    samples: { ranked: [], room: [] },
    transportEvents: [],
    errors: [],
    usage: [],
  },
  clients = new Set(),
  actors = new Map();
let commands = 0,
  stopping = false;
let originalPeerState;
const unapprovedPeerState = {
  approved: false,
  discovered: true,
  participationBlocked: false,
};
process.on('SIGINT', () => {
  stopping = true;
});

async function api(node, route, input) {
  const response = await request(
    `${origins[node]}/api/probes/game/${route === 'peer-state' ? route : `load/${route}`}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens[node]}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(route === 'peer-state' ? input : { runId, ...input }),
      signal: AbortSignal.timeout(20000),
    },
  );
  const body = await response.json();
  if (response.status !== 200 || body.ok === false) {
    const ray = response.headers.get('cf-ray');
    const event = {
      event: 'api_failed',
      at: new Date().toISOString(),
      node,
      route,
      status: response.status,
      ray: /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : undefined,
      code: /^[A-Z_0-9]{3,80}$/.test(body.code) ? body.code : undefined,
      action: ['session', 'ready', 'start', 'leave', 'return', 'settings'].includes(
        input.action,
      )
        ? input.action
        : undefined,
      index:
        Number.isInteger(input.index) && input.index >= 0 && input.index <= 12
          ? input.index
          : undefined,
      operationId: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
        input.operationId,
      )
        ? input.operationId
        : undefined,
    };
    report.transportEvents.push(event);
    console.log(JSON.stringify(event));
  }
  assert.equal(
    response.status,
    200,
    `${node}/${route} HTTP ${response.status} ${body.code ?? ''}`,
  );
  assert.notEqual(body.ok, false, `${node}/${route} ${body.code}`);
  return body;
}
async function until(predicate, label, timeout = 45000, cohort = []) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await recoverGames(cohort);
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`);
    await pause(25);
  }
}
async function open(
  index,
  entry,
  kind = 'game',
  foreign = null,
  existing = null,
  deadline = Date.now() + connection.retryWindowMs,
) {
  let retries = 0;
  for (;;) {
    try {
      const client = await openSocket(index, entry, kind, foreign, existing, deadline);
      if (retries) client.transportEvent({ event: 'socket_connect_recovered', retries });
      return client;
    } catch (error) {
      const transient =
        ['ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(error.code) ||
        /^Unexpected server response: (502|503|504)$/.test(error.message) ||
        ['Opening handshake has timed out', 'Timeout: initial state'].includes(
          error.message,
        );
      if (!transient || stopping || Date.now() + connection.retryIntervalMs >= deadline)
        throw error;
      const event = {
        event: 'socket_connect_retry',
        at: new Date().toISOString(),
        kind,
        index,
        room: entry.room,
        retry: ++retries,
      };
      report.transportEvents.push(event);
      console.log(JSON.stringify(event));
      await pause(connection.retryIntervalMs);
    }
  }
}
async function openSocket(index, entry, kind, foreign, existing, deadline) {
  const connectingAt = Date.now();
  let heartbeatTimer;
  const url = foreign
    ? `${origins.a.replace('https:', 'wss:')}/api/v1/participation/socket?reservation=${foreign.reservationId}`
    : `${origins.a.replace('https:', 'wss:')}/api/probes/game/load/socket?${new URLSearchParams({ runId, index: String(index), room: entry.room, kind })}`;
  const connectionId = crypto.randomUUID();
  const socket = new WebSocket(transportUrl(`${url}&connection=${connectionId}`), {
      handshakeTimeout: Math.max(
        1,
        Math.min(connection.connectTimeoutMs, deadline - Date.now()),
      ),
      headers: foreign
        ? { Cookie: foreign.cookie, Origin: origins.a }
        : {
            Authorization: `Bearer ${tokens.a}`,
            'X-QA-Session': entry.token,
            Origin: origins.a,
          },
    }),
    client = existing ?? {
      socket,
      index,
      entry,
      kind,
      foreign,
      connectionId,
      lastReceivedAt: null,
      state: null,
      panel: null,
      lobby: null,
      actorId: null,
      acks: new Map(),
      pending: new Map(),
      inflight: new Map(),
      intentionalClose: false,
    };
  Object.assign(client, {
    socket,
    connectionId,
    lastReceivedAt: null,
    ready: false,
    intentionalClose: false,
    plannedDisconnect: false,
  });
  if (client.connectionFailure)
    client.recoveryAttempts = (client.recoveryAttempts ?? 0) + 1;
  clients.add(client);
  const transportEvent = (event) => {
    const details = {
      ...event,
      connectionId,
      at: new Date().toISOString(),
      kind,
      index,
      room: entry.room,
      phase: client.state?.phase ?? null,
      matchId: client.state?.matchId ?? null,
      roomSeq: client.state?.roomSeq ?? null,
      result: client.state?.result ?? null,
      lastReceivedAt: client.lastReceivedAt,
      playing: client.lobby?.playing ?? null,
      hostId: client.lobby?.hostId,
      presenter: client.lobby?.settings.presenter,
      revision: client.lobby?.revision,
    };
    report.transportEvents.push(details);
    console.log(JSON.stringify(details));
  };
  socket.on('error', (error) => {
    if (!client.intentionalClose && client.socket === socket)
      transportEvent({
        event: 'socket_error',
        code: /^[A-Z_0-9]{3,80}$/.test(error.code ?? '') ? error.code : 'omitted',
      });
  });
  socket.on('close', (code, reason) => {
    clearInterval(heartbeatTimer);
    if (client.socket !== socket) return;
    if (!client.intentionalClose && !client.connectionFailure)
      client.connectionFailure = {
        connectionId,
        at: Date.now(),
        trigger: 'close',
        closeCode: code,
        ...(client.lastReceivedAt
          ? {
              lastStateAgeMs: Math.max(0, Date.now() - Date.parse(client.lastReceivedAt)),
            }
          : {}),
      };
    if (!client.intentionalClose && reason.toString() === 'MATCH_FINISHED')
      transportEvent({ event: 'match_finished', code });
    if (!client.intentionalClose && reason.toString() !== 'MATCH_FINISHED')
      transportEvent({
        event: client.plannedDisconnect ? 'planned_close' : 'unexpected_close',
        code,
        reason: ['Closed', 'HEARTBEAT_TIMEOUT', 'SESSION_INVALID'].includes(
          reason.toString(),
        )
          ? reason.toString()
          : 'omitted',
      });
  });
  socket.on('message', (data) => {
    if (client.socket !== socket || client.intentionalClose) return;
    client.lastReceivedAt = new Date().toISOString();
    const message = JSON.parse(data.toString());
    if (message.type === 'state') client.state = message.snapshot;
    if (message.type === 'delta' && client.state)
      for (const event of message.events)
        Object.assign(client.state, event.changes, { roomSeq: event.roomSeq });
    if (['state', 'delta'].includes(message.type)) {
      client.ready = true;
      client.panel = message.panel;
      client.actorId = message.actorId;
    }
    if (message.type === 'lobby') {
      client.ready = true;
      client.lobby = message.room;
    }
    if (message.type === 'ack') {
      const started = client.pending.get(message.reply.commandId);
      if (started !== undefined) {
        const elapsedMs = performance.now() - started;
        report.samples[index < 4 ? 'ranked' : 'room'].push(elapsedMs);
        if (elapsedMs >= 500)
          transportEvent({
            event: 'slow_ack',
            commandId: message.reply.commandId,
            type: client.inflight.get(message.reply.commandId)?.type,
            elapsedMs,
            ok: message.reply.ok,
            code: message.reply.code,
          });
        client.pending.delete(message.reply.commandId);
        client.inflight.delete(message.reply.commandId);
      }
      client.acks.set(message.reply.commandId, message.reply);
    }
    if (message.type === 'error') report.errors.push({ index, code: message.code });
  });
  client.close = () => {
    client.intentionalClose = true;
    clearInterval(heartbeatTimer);
    socket.close();
    clients.delete(client);
  };
  client.transportEvent = transportEvent;
  try {
    await once(socket, 'open');
    for (const command of client.inflight.values()) socket.send(JSON.stringify(command));
    socket.send('sync');
    await until(
      () => client.ready,
      'initial state',
      Math.min(connection.connectTimeoutMs, Math.max(0, deadline - Date.now())),
    );
    const diagnostic = {
      type: 'connection_report',
      connectMs: Math.max(0, Date.now() - connectingAt),
      recovery: client.connectionFailure
        ? {
            ...client.connectionFailure,
            attempts: client.recoveryAttempts,
            elapsedMs: Math.max(0, Date.now() - client.connectionFailure.at),
          }
        : undefined,
    };
    const sent = (error) =>
      transportEvent({
        event: error ? 'connection_report_send_failed' : 'connection_report_sent',
        recoveryConnectionId: diagnostic.recovery?.connectionId,
      });
    // The callback confirms the local write, not server receipt or log persistence.
    // Diagnostic failure must not change the match result.
    try {
      socket.send(JSON.stringify(diagnostic), sent);
    } catch (error) {
      sent(error);
    }
    client.connectionFailure = undefined;
    client.recoveryAttempts = 0;
    let lastSyncAt = Date.now();
    if (socket.readyState === WebSocket.OPEN)
      heartbeatTimer = setInterval(() => {
        const now = Date.now();
        if (now - lastSyncAt > 10000)
          transportEvent({ event: 'heartbeat_gap', elapsedMs: now - lastSyncAt });
        lastSyncAt = now;
        if (socket.readyState === WebSocket.OPEN) socket.send('sync');
      }, 5000);
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
}
async function savedSnapshot(client) {
  const matchId = client.state.matchId;
  let page;
  if (client.foreign) {
    const response = await request(
      `${origins.a}/api/play/results?instance=${foreignLogin.hostInstanceId}&reservation=${client.foreign.reservationId}`,
      {
        method: 'POST',
        headers: {
          Origin: origins.a,
          Cookie: client.foreign.cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ section: 'history', matchId }),
        signal: AbortSignal.timeout(connection.connectTimeoutMs),
      },
    );
    assert.equal(response.status, 200, 'result recovery authorization');
    page = await response.json();
  } else page = await api('a', 'results', { index: client.index, matchId });
  const result = page.history.find((item) => item.matchId === matchId)?.snapshot;
  if (!result) return null;
  assert.equal(result.matchId, matchId, 'result recovery changed match');
  assert.equal(result.result?.storage, 'confirmed', 'result recovery is not confirmed');
  assert(
    ['FINISHED', 'INVALID'].includes(result.phase),
    'result recovery is not terminal',
  );
  return result;
}
async function recoverGame(client) {
  if (client.recovering) return client.recovering;
  client.recovering = (async () => {
    const matchId = client.state.matchId;
    const deadline = Date.now() + connection.retryWindowMs;
    client.transportEvent({ event: 'game_recovery_started' });
    // Recovery may start before ws dispatches its close callback. Capture the
    // observed state before close() marks the transport as intentionally closed.
    if (!client.connectionFailure)
      client.connectionFailure = {
        connectionId: client.connectionId,
        at: Date.now(),
        trigger:
          client.socket.readyState === WebSocket.OPEN ? 'receive_timeout' : 'close',
        ...(client.lastReceivedAt
          ? {
              lastStateAgeMs: Math.max(0, Date.now() - Date.parse(client.lastReceivedAt)),
            }
          : {}),
      };
    client.close();
    clients.add(client);
    while (true) {
      // A deleted match is recovered from its D1 original, through this actor's access.
      const saved = await savedSnapshot(client);
      if (saved) {
        client.state = saved;
        client.resultRecovered = true;
        client.transportEvent({ event: 'game_result_restored' });
        clients.delete(client);
        return;
      }
      try {
        await open(client.index, client.entry, 'game', client.foreign, client, deadline);
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        clients.add(client);
        await pause(connection.retryIntervalMs);
        continue;
      }
      assert.equal(client.state.matchId, matchId, 'reconnect changed match');
      client.plannedDisconnect = false;
      client.transportEvent({ event: 'game_reconnected' });
      return;
    }
  })();
  try {
    await client.recovering;
  } finally {
    client.recovering = null;
  }
}
async function recoverGames(cohort) {
  await Promise.all(
    cohort
      .filter((client) => {
        if (client.recovering) return true;
        if (client.kind !== 'game' || !client.ready || client.intentionalClose)
          return false;
        if (client.state.result?.storage === 'confirmed') return false;
        if (
          client.holdUntilSaved &&
          ![...clients].some(
            (peer) =>
              peer !== client &&
              peer.state?.matchId === client.state.matchId &&
              peer.state.result?.storage === 'confirmed',
          )
        )
          return false;
        return (
          client.socket.readyState !== WebSocket.OPEN ||
          Date.now() - Date.parse(client.lastReceivedAt) >= connection.receiveTimeoutMs
        );
      })
      .map(recoverGame),
  );
}
function cutGame(client, boundary) {
  client.plannedDisconnect = true;
  client.holdUntilSaved = boundary === 'before_result';
  client.transportEvent({ event: 'planned_game_disconnect', boundary });
  client.socket.terminate();
}
async function send(client, type, payload = {}, original = null) {
  await recoverGames([client]);
  if (++commands > 12000) {
    stopping = true;
    throw new Error('Command safety budget reached');
  }
  const command = original ?? {
    commandId: crypto.randomUUID(),
    matchId: client.state.matchId,
    questionId: client.state.questionId,
    type,
    payload,
  };
  client.acks.delete(command.commandId);
  client.pending.set(command.commandId, performance.now());
  client.inflight.set(command.commandId, command);
  client.socket.send(JSON.stringify(command));
  await until(
    () => {
      const reply = client.acks.get(command.commandId);
      return reply && client.state.roomSeq >= reply.roomSeq;
    },
    `${type} ACK and state`,
    connection.retryWindowMs + 10000,
    [client],
  );
  return { command, reply: client.acks.get(command.commandId) };
}
let foreignLogin;
async function foreignEntry() {
  if (!foreignLogin) {
    const state = crypto.randomUUID();
    const { ticket, hostInstanceId, sourceOrganizationId } = await api('b', 'enter', {
      index: 3,
      mode: 'foreign',
      operationId: state,
    });
    const response = await request(`${origins.a}/api/v1/participation/login/exchange`, {
      method: 'POST',
      headers: { Origin: origins.a, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket,
        state,
        hostInstanceId,
        sourceOrganizationId,
        peerOrigin: origins.b,
        mode: 'ranked',
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json();
    assert.equal(
      response.status,
      200,
      `login HTTP ${response.status} ${body.code ?? ''}`,
    );
    foreignLogin = {
      hostInstanceId,
      cookie: response.headers.get('set-cookie').split(';')[0],
    };
    report.foreignLogin.logins++;
  }
  const response = await request(`${origins.a}/api/v1/participation/login/join`, {
    method: 'POST',
    headers: {
      Origin: origins.a,
      'Content-Type': 'application/json',
      Cookie: foreignLogin.cookie,
    },
    body: JSON.stringify({
      hostInstanceId: foreignLogin.hostInstanceId,
      mode: 'ranked',
      operationId: crypto.randomUUID(),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  assert.equal(
    response.status,
    200,
    `login join HTTP ${response.status} ${body.code ?? ''}`,
  );
  report.foreignLogin.joins++;
  return {
    reservationId: body.reservationId,
    cookie: response.headers.get('set-cookie').split(';')[0],
  };
}
async function match(cohort, mode, presenter = null) {
  const first = cohort[0];
  try {
    await until(() => first.state.phase === 'REVEALING', `${mode} start`, 45000, cohort);
  } catch (error) {
    report[mode].startStates = cohort.map((client) => ({
      index: client.index,
      connectionId: client.connectionId,
      socket: client.socket.readyState,
      lastReceivedAt: client.lastReceivedAt,
      roomSeq: client.state.roomSeq,
      matchId: client.state.matchId,
      phase: client.state.phase,
      playersRequired: client.state.playersRequired,
      players: client.state.players.map((player) => ({
        connected: player.connected,
        forfeited: player.forfeited,
      })),
    }));
    throw error;
  }
  const players = mode === 'ranked' ? (rankedOnly ? 2 : 4) : 8;
  assert.equal(first.state.playersRequired, players);
  assert.equal(first.state.players.length, players + (presenter ? 1 : 0));
  if (presenter)
    assert.equal((await send(presenter, 'buzz')).reply.code, 'PRESENTER_CANNOT_ANSWER');
  let questionNumber = 0,
    tested = false,
    resultCut = false;
  while (!['FINISHED', 'INVALID'].includes(first.state.phase)) {
    await until(
      () =>
        ['FINISHED', 'INVALID'].includes(first.state.phase) ||
        (first.state.phase === 'REVEALING' &&
          first.state.questionNumber > questionNumber &&
          first.state.text.length >= 12),
      `${mode} question`,
      30000,
      cohort,
    );
    if (['FINISHED', 'INVALID'].includes(first.state.phase)) break;
    questionNumber = first.state.questionNumber;
    const question = questions.find((question) =>
      graphemes(question.text).join('').startsWith(first.state.text),
    );
    assert(question, `${mode} fixture question not recognized`);
    const answerers = cohort.filter((client) => client !== presenter),
      wanted = answerers[(report[mode].games + questionNumber) % answerers.length],
      buzz = await send(wanted, 'buzz');
    assert(buzz.reply.ok, `buzz ${buzz.reply.code}`);
    await until(
      () => {
        if (
          wanted.state.questionId !== buzz.command.questionId ||
          wanted.state.phase !== 'ANSWERING' ||
          wanted.state.holder !== wanted.actorId
        ) {
          wanted.transportEvent({
            event: 'answer_window_lost',
            commandId: buzz.command.commandId,
            questionId: buzz.command.questionId,
            currentQuestionId: wanted.state.questionId,
            holder: wanted.state.holder,
            deadline: wanted.state.deadline,
            judgment: wanted.state.judgment,
          });
          throw new Error(`${mode}: answer window lost after buzz ACK`);
        }
        return wanted.panel;
      },
      'answer panel',
      45000,
      [wanted],
    );
    for (const letter of Array.from(question.answer)) {
      const panel = wanted.panel;
      assert(panel, 'answer panel missing');
      const choice = panel.choices.find((choice) => choice.text === letter);
      assert(choice, 'fixture answer not in panel');
      if (
        disconnectBoundaries &&
        report[mode].games === 0 &&
        !resultCut &&
        first.state.questionNumber === first.state.questionCount &&
        panel.position === Array.from(question.answer).length - 1
      ) {
        const target = cohort.findLast(
          (client) => client !== first && client !== wanted && client !== presenter,
        );
        assert(target, 'no participant available for result disconnection');
        cutGame(target, 'before_result');
        resultCut = true;
      }
      const chosen = await send(wanted, 'choose', {
        attemptId: panel.attemptId,
        panelId: panel.panelId,
        choiceId: choice.id,
      });
      if (!chosen.reply.ok)
        wanted.transportEvent({
          event: 'answer_rejected',
          commandId: chosen.command.commandId,
          questionId: chosen.command.questionId,
          code: chosen.reply.code,
          panelId: panel.panelId,
          deadline: panel.deadline,
          judgment: wanted.state.judgment,
        });
      assert(chosen.reply.ok, `choose ${chosen.reply.code}`);
      await pause(150);
    }
    if (!tested) {
      const replay = await send(wanted, 'buzz', {}, buzz.command);
      assert.deepEqual(replay.reply, buzz.reply, 'duplicate command changed judgment');
      report[mode].duplicates++;
      const reconnect = cohort[cohort.length - 1],
        replacementIndex = cohort.indexOf(reconnect);
      cutGame(reconnect, 'round_reconnect');
      // Reuse any recovery already started for this participant.
      await recoverGame(reconnect);
      const restored = reconnect;
      assert.equal(
        restored.state.matchId,
        first.state.matchId,
        'reconnect changed match',
      );
      assert.equal(
        restored.state.questionNumber,
        first.state.questionNumber,
        'reconnect lost question',
      );
      cohort[replacementIndex] = restored;
      report[mode].reconnects++;
      tested = true;
    }
    if (presenter) {
      await until(
        () =>
          presenter.state.phase === 'JUDGED' &&
          Date.now() >= (presenter.state.deadline ?? Infinity) + 200,
        'presenter next available',
        45000,
        [presenter],
      );
      const next = await send(presenter, 'next');
      assert(next.reply.ok, `presenter next ${next.reply.code}`);
    }
  }
  if (disconnectBoundaries && report[mode].games === 0)
    assert(resultCut, `${mode} final-boundary disconnection was not exercised`);
  assert.equal(first.state.phase, 'FINISHED', `${mode} invalidated`);
  await until(
    () => first.state.result?.storage === 'confirmed',
    `${mode} result saved`,
    30000,
    cohort,
  );
  const matchId = first.state.matchId;
  try {
    await until(
      () =>
        cohort.every(
          (client) =>
            client.state.matchId === matchId &&
            client.state.result &&
            ['FINISHED', 'INVALID'].includes(client.state.phase),
        ),
      `${mode} cohort result consistency`,
      45000,
      cohort,
    );
  } catch (error) {
    report[mode].endStates = cohort.map((client) => ({
      index: client.index,
      connectionId: client.connectionId,
      lastReceivedAt: client.lastReceivedAt,
      socket: client.socket.readyState,
      matchId: client.state.matchId,
      phase: client.state.phase,
      roomSeq: client.state.roomSeq,
      result: client.state.result,
      players: client.state.players,
    }));
    throw error;
  }
  const saved = await api('a', 'results', { index: first.index, matchId });
  assert(saved.history[0]?.snapshot, 'D1 result snapshot missing');
  assert.equal(saved.history[0].snapshot.matchId, matchId);
  const expected = { matchId, ...first.state.result, players: first.state.players };
  for (const client of cohort) {
    assertMatchResult(expected, {
      matchId: client.state.matchId,
      ...client.state.result,
      players: client.state.players,
    });
    if (!client.foreign) {
      const personal = await api('a', 'results', { index: client.index, matchId });
      const snapshot = personal.history[0]?.snapshot;
      assert(snapshot, 'personal D1 result missing');
      assertMatchResult(expected, {
        matchId: snapshot.matchId,
        ...snapshot.result,
        players: snapshot.players,
      });
    }
  }
  for (const client of cohort.filter((client) => client.foreign)) {
    const response = await request(
      `${origins.a}/api/play/results?instance=${saved.instanceId}&reservation=${client.foreign.reservationId}`,
      {
        method: 'POST',
        headers: {
          Origin: origins.a,
          Cookie: client.foreign.cookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ section: 'history', matchId }),
        signal: AbortSignal.timeout(20000),
      },
    );
    assert.equal(response.status, 200, 'foreign D1 result access');
    const restored = await response.json();
    assert.deepEqual(
      restored.history[0]?.snapshot,
      saved.history[0].snapshot,
      'foreign D1 result differs',
    );
  }
  report[mode].games++;
  return matchId;
}
async function ranked() {
  let end = Infinity;
  while (!stopping && Date.now() < end) {
    const cohort = [];
    for (let index = 0; index < (rankedOnly ? 1 : 3); index++) {
      const entry = await api('a', 'enter', {
        index,
        mode: 'ranked',
        operationId: crypto.randomUUID(),
      });
      cohort.push(await open(index, entry));
    }
    cohort.push(await open(3, { room: '' }, 'game', await foreignEntry()));
    if (end === Infinity) {
      report.ranked.activeStartedAt = new Date().toISOString();
      end = Date.now() + minutes * 60000;
    }
    const matchId = await match(cohort, 'ranked');
    const delivery = {
      matchId,
      finishedAt: cohort[0].state.result.finishedAt,
      confirmedAt: Date.now(),
      historyAt: null,
    };
    report.ranked.deliveries.push(delivery);
    for (const client of cohort) client.close();
    const deadline = Date.now() + 90000;
    while (true) {
      const page = await api('b', 'history', { index: 3 });
      const delivered = page.history.find((entry) => entry.matchId === matchId);
      if (delivered) {
        assertMatchResult(
          { matchId, ...cohort[0].state.result, players: cohort[0].state.players },
          delivered,
        );
        delivery.historyAt = Date.now();
        delivery.latencyMs = delivery.historyAt - delivery.confirmedAt;
        break;
      }
      assert(Date.now() < deadline, 'own result did not reach source history');
      await pause(3000);
    }
    await pause(2000);
  }
}
async function rooms() {
  let end = Infinity;
  let disconnected = false;
  const lobbies = [];
  let hostIndex = 4;
  async function recoverLobbies() {
    for (let index = 0; index < lobbies.length; index++) {
      const client = lobbies[index];
      if (client.socket.readyState === WebSocket.OPEN) continue;
      client.close();
      const deadline = Date.now() + 30000;
      while (true) {
        try {
          const restored = await open(
            client.index,
            client.entry,
            'lobby',
            null,
            client,
            deadline,
          );
          assert.equal(
            restored.lobby.id,
            client.entry.room,
            'reconnect changed parent room',
          );
          lobbies[index] = restored;
          report.room.transportRecoveries++;
          const event = {
            event: 'lobby_restored',
            at: new Date().toISOString(),
            connectionId: restored.connectionId,
            index: client.index,
            room: restored.lobby.id,
          };
          report.transportEvents.push(event);
          console.log(JSON.stringify(event));
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await pause(1500);
        }
      }
    }
  }
  for (let index = 4; index <= 12; index++) {
    const entry = await api('a', 'enter', {
      index,
      mode: 'room',
      operationId: crypto.randomUUID(),
    });
    lobbies.push(await open(index, { ...entry, room: runId }, 'lobby'));
  }
  matches: while (!stopping && Date.now() < end) {
    let recoveryDeadline;
    for (;;) {
      await recoverLobbies();
      const current = await api('a', 'room', {
        index: 4,
        token: lobbies[0].entry.token,
        action: 'return',
        operationId: crypto.randomUUID(),
      });
      const host = lobbies.find(
        (client) => actors.get(client.index) === current.lobby.hostId,
      );
      assert(host, 'current room host is not in the test cohort');
      hostIndex = host.index;
      if (!current.lobby.settings.presenter) {
        const event = {
          event: 'presenter_reselected',
          at: new Date().toISOString(),
          index: hostIndex,
          revision: current.lobby.revision,
          members: current.lobby.members.length,
        };
        await api('a', 'room', {
          index: hostIndex,
          token: host.entry.token,
          action: 'settings',
          settings: { ...current.lobby.settings, presenter: true },
          operationId: crypto.randomUUID(),
        });
        report.transportEvents.push(event);
        console.log(JSON.stringify(event));
      }
      for (const client of lobbies) {
        await api('a', 'room', {
          index: client.index,
          token: client.entry.token,
          action: 'return',
          operationId: crypto.randomUUID(),
        });
        await api('a', 'room', {
          index: client.index,
          token: client.entry.token,
          action: 'ready',
          operationId: crypto.randomUUID(),
        });
      }
      if (disconnectHost && !disconnected) {
        disconnected = true;
        host.plannedDisconnect = true;
        host.socket.terminate();
        await until(
          () =>
            lobbies.some(
              (client) => client !== host && client.lobby.hostId !== current.lobby.hostId,
            ),
          'host transfer',
        );
        continue;
      }
      if (disconnectLobbies && !disconnected) {
        const preparationDeadline = Date.now() + 30000;
        disconnected = true;
        report.room.plannedDisconnects = lobbies.length;
        const event = {
          event: 'planned_lobby_disconnect',
          at: new Date().toISOString(),
          kind: 'lobby',
          room: runId,
          count: lobbies.length,
        };
        report.transportEvents.push(event);
        console.log(JSON.stringify(event));
        // Confirm the other sockets are gone before closing the host; otherwise
        // the deliberate individual-host transfer changes the presenter's role.
        for (const client of lobbies.slice(1)) {
          client.plannedDisconnect = true;
          client.socket.terminate();
        }
        const host = lobbies[0],
          hostId = host.lobby.hostId,
          operationId = crypto.randomUUID();
        for (;;) {
          const current = await api('a', 'room', {
            index: host.index,
            token: host.entry.token,
            action: 'return',
            operationId,
          });
          if (
            current.lobby.members.every(
              (member) => member.id === hostId || !member.connected,
            )
          )
            break;
          assert(Date.now() < preparationDeadline, 'planned disconnect was not observed');
          await pause(100);
        }
        host.plannedDisconnect = true;
        host.socket.terminate();
        await until(
          () => lobbies.every((client) => client.socket.readyState === WebSocket.CLOSED),
          'planned lobby disconnect',
        );
        event.completedAt = new Date().toISOString();
        continue;
      }
      if (stopping || Date.now() >= end) break matches;
      try {
        await api('a', 'room', {
          index: hostIndex,
          token: host.entry.token,
          action: 'start',
          operationId: crypto.randomUUID(),
        });
        break;
      } catch (error) {
        const event = {
          event: 'room_start_failed',
          at: new Date().toISOString(),
          hostIndex,
          hostId: host.lobby.hostId,
          revision: host.lobby.revision,
          presenter: host.lobby.settings.presenter,
          capacity: host.lobby.settings.capacity,
          members: host.lobby.members.map(({ id, connected, ready }) => ({
            id,
            connected,
            ready,
          })),
        };
        report.transportEvents.push(event);
        console.log(JSON.stringify(event));
        // A disconnect during the sequential ready calls is still recoverable.
        if (
          !error.message.includes('ROOM_NOT_READY') ||
          !lobbies.some((client) => client.socket.readyState !== WebSocket.OPEN)
        )
          throw error;
        recoveryDeadline ??= Date.now() + 30000;
        if (Date.now() >= recoveryDeadline) throw error;
      }
    }
    const cohort = [];
    for (const client of lobbies) {
      const entry = await api('a', 'room', {
        index: client.index,
        token: client.entry.token,
        action: 'session',
      });
      cohort.push(await open(client.index, entry));
      if (disconnectBoundaries && report.room.games === 0 && cohort.length === 1) {
        cutGame(cohort[0], 'waiting');
        await recoverGame(cohort[0]);
      }
    }
    if (end === Infinity) {
      report.room.activeStartedAt = new Date().toISOString();
      end = Date.now() + minutes * 60000;
    }
    await match(
      cohort,
      'room',
      cohort.find((client) => client.index === hostIndex),
    );
    for (const client of cohort) client.close();
    for (const client of lobbies) {
      const returned = await api('a', 'room', {
        index: client.index,
        token: client.entry.token,
        action: 'return',
        operationId: crypto.randomUUID(),
      });
      assert.equal(returned.lobby.playing, false, 'server still playing after return');
      assert.equal(returned.lobby.matchRoom, null, 'server did not restore parent lobby');
    }
    await recoverLobbies();
    await until(
      () => lobbies.every((client) => !client.lobby.playing && !client.lobby.matchRoom),
      `parent lobby return ${JSON.stringify(lobbies.map((client) => ({ index: client.index, socket: client.socket.readyState, playing: client.lobby?.playing, inMatch: !!client.lobby?.matchRoom })))}`,
    );
    await pause(2000);
  }
  for (const client of lobbies.slice().reverse()) {
    client.intentionalClose = true;
    await api('a', 'room', {
      index: client.index,
      token: client.entry.token,
      action: 'leave',
      operationId: crypto.randomUUID(),
    });
    client.close();
  }
}
function save() {
  const output = {
    ...report,
    finishedAt: new Date().toISOString(),
    commands,
    samples: undefined,
    latency: {},
  };
  for (const [mode, samples] of Object.entries(report.samples)) {
    const sorted = samples.slice().sort((a, b) => a - b);
    output.latency[mode] = {
      count: sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
      p99: sorted[Math.floor(sorted.length * 0.99)] ?? null,
    };
  }
  return output;
}
let readingUsage = false;
let usagePending = Promise.resolve();
const usageIntervalMs = 5 * 60000;
let nextUsageAt = 0;
const progress = setInterval(() => {
  if (readingUsage) return;
  usagePending = (async () => {
    readingUsage = true;
    try {
      if (!local && !stopping && Date.now() >= nextUsageAt) {
        nextUsageAt = Date.now() + usageIntervalMs;
        const usage = await cloudUsage();
        report.usage.push(usage);
        assertFreeBudget(usage);
      }
    } catch (error) {
      stopping = true;
      report.errors.push({ message: error.message, diagnostics: error.diagnostics });
    } finally {
      readingUsage = false;
    }
    console.log(
      JSON.stringify({ event: 'progress', ...save(), usage: report.usage.slice(-1) }),
    );
  })();
  return usagePending;
}, 60000);
try {
  if (!local) {
    nextUsageAt = Date.now() + usageIntervalMs;
    const usage = await cloudUsage();
    report.usage.push(usage);
    assertFreeBudget(usage);
  }
  // Account registration is a separate setup step, not concurrent game traffic.
  for (const index of rankedOnly
    ? [0, 3]
    : roomsOnly
      ? Array.from({ length: 9 }, (_, index) => index + 4)
      : Array.from({ length: 13 }, (_, index) => index))
    actors.set(index, (await api(index === 3 ? 'b' : 'a', 'prepare', { index })).actorId);
  if (unapproved) {
    originalPeerState = await api('b', 'peer-state', {});
    assert(
      originalPeerState.approved && !originalPeerState.participationBlocked,
      'Consent QA requires an initially approved, unblocked QA peer',
    );
    await api('b', 'peer-state', {
      expected: originalPeerState,
      next: unapprovedPeerState,
    });
    report.unapprovedSource = true;
  }
  if (!roomsOnly) await api('a', 'config', { players: rankedOnly ? 2 : 4 });
  const fail = (error) => {
    stopping = true;
    report.errors.push({ message: error.message });
    console.log(JSON.stringify({ event: 'failure', message: error.message }));
  };
  const results = await Promise.allSettled([
    ...(roomsOnly ? [] : [ranked().catch(fail)]),
    ...(rankedOnly ? [] : [rooms().catch(fail)]),
  ]);
  for (const result of results)
    if (result.status === 'rejected')
      report.errors.push({ message: result.reason.message });
} catch (error) {
  report.errors.push({ message: error.message, diagnostics: error.diagnostics });
} finally {
  stopping = true;
  clearInterval(progress);
  for (const client of clients) client.close();
  if (originalPeerState)
    try {
      await api('b', 'peer-state', {
        expected: unapprovedPeerState,
        next: originalPeerState,
      });
      report.peerStateRestored = true;
    } catch (error) {
      report.errors.push({ message: `restore peer: ${error.message}` });
    }
  try {
    if (!roomsOnly) {
      await api('a', 'config', { players: 2 });
      report.configRestored = true;
    }
  } catch (error) {
    report.errors.push({ message: `restore: ${error.message}` });
  }
  await usagePending;
  const output = save();
  await writeFile(
    `.wrangler/qa/federation-load-${runId}.json`,
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log(JSON.stringify(output));
  if (report.errors.length) process.exitCode = 1;
}
