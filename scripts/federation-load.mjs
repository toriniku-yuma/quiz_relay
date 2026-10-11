import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import { assertFreeBudget, cloudUsage } from './federation-usage.mjs';

// Reuse Wrangler's installed WebSocket client; no browser credentials are exported.
const require = createRequire(import.meta.url),
  WebSocket = createRequire(require.resolve('wrangler'))('ws');
const minutes = Number(process.argv[2] ?? 1);
const unapproved = process.argv.includes('--unapproved');
const disconnectLobbies = process.argv.includes('--disconnect-lobbies');
const rankedOnly = process.argv.includes('--ranked-only');
assert(!rankedOnly || !disconnectLobbies, 'Lobby disconnection requires the room test');
assert(minutes > 0 && minutes <= 30, 'Duration must be in (0, 30] minutes');
const runId = crypto.randomUUID(),
  origins = Object.fromEntries(
    ['a', 'b'].map((node) => [
      node,
      `https://quiz-relay-federation-${node}-test.quiz-relay.workers.dev`,
    ]),
  ),
  tokens = {};
for (const node of ['a', 'b'])
  tokens[node] = JSON.parse(
    await readFile(`.wrangler/federation-${node}-secrets.json`, 'utf8'),
  ).PROBE_TOKEN;
const questions = JSON.parse(await readFile('supabase/seeds/mock-hiragana.json', 'utf8')),
  report = {
    runId,
    startedAt: new Date().toISOString(),
    requestedMinutes: minutes,
    scenario: rankedOnly
      ? 'two-player ranked only'
      : 'four-player ranked and nine-player room',
    auth: 'isolated QA fixture; normal signed federation/cookie/DO paths',
    ranked: { games: 0, reconnects: 0, duplicates: 0, deliveries: [] },
    room: { games: 0, reconnects: 0, duplicates: 0, transportRecoveries: 0 },
    samples: { ranked: [], room: [] },
    transportEvents: [],
    errors: [],
    usage: [],
  },
  clients = new Set();
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
  const response = await fetch(
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
  assert.equal(
    response.status,
    200,
    `${node}/${route} HTTP ${response.status} ${body.code ?? ''}`,
  );
  assert.notEqual(body.ok, false, `${node}/${route} ${body.code}`);
  return body;
}
async function until(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`);
    await pause(25);
  }
}
async function open(index, entry, kind = 'game', foreign = null) {
  const url = foreign
    ? `${origins.a.replace('https:', 'wss:')}/api/v1/participation/socket?reservation=${foreign.reservationId}`
    : `${origins.a.replace('https:', 'wss:')}/api/probes/game/load/socket?${new URLSearchParams({ runId, index: String(index), room: entry.room, kind })}`;
  const socket = new WebSocket(url, {
      handshakeTimeout: 10000,
      headers: foreign
        ? { Cookie: foreign.cookie, Origin: origins.a }
        : {
            Authorization: `Bearer ${tokens.a}`,
            'X-QA-Session': entry.token,
            Origin: origins.a,
          },
    }),
    client = {
      socket,
      index,
      entry,
      kind,
      foreign,
      state: null,
      panel: null,
      lobby: null,
      actorId: null,
      acks: new Map(),
      pending: new Map(),
      intentionalClose: false,
    };
  clients.add(client);
  const transportEvent = (event) => {
    const details = {
      ...event,
      at: new Date().toISOString(),
      kind,
      index,
      room: entry.room,
      phase: client.state?.phase ?? null,
      playing: client.lobby?.playing ?? null,
    };
    report.transportEvents.push(details);
    console.log(JSON.stringify(details));
  };
  socket.on('error', (error) => {
    if (!client.intentionalClose)
      transportEvent({
        event: 'socket_error',
        code: /^[A-Z_0-9]{3,80}$/.test(error.code ?? '') ? error.code : 'omitted',
      });
  });
  socket.on('close', (code, reason) => {
    if (!client.intentionalClose)
      transportEvent({
        event: 'unexpected_close',
        code,
        reason: ['Closed', 'HEARTBEAT_TIMEOUT', 'SESSION_INVALID'].includes(
          reason.toString(),
        )
          ? reason.toString()
          : 'omitted',
      });
  });
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'state') client.state = message.snapshot;
    if (message.type === 'delta' && client.state)
      for (const event of message.events)
        Object.assign(client.state, event.changes, { roomSeq: event.roomSeq });
    if (['state', 'delta'].includes(message.type)) {
      client.panel = message.panel;
      client.actorId = message.actorId;
    }
    if (message.type === 'lobby') client.lobby = message.room;
    if (message.type === 'ack') {
      const started = client.pending.get(message.reply.commandId);
      if (started !== undefined) {
        report.samples[index < 4 ? 'ranked' : 'room'].push(performance.now() - started);
        client.pending.delete(message.reply.commandId);
      }
      client.acks.set(message.reply.commandId, message.reply);
    }
    if (message.type === 'error') report.errors.push({ index, code: message.code });
  });
  client.close = () => {
    client.intentionalClose = true;
    clearInterval(client.timer);
    socket.close();
    clients.delete(client);
  };
  try {
    await once(socket, 'open');
    socket.send('sync');
    await until(() => (kind === 'lobby' ? client.lobby : client.state), 'initial state');
    let lastSyncAt = Date.now();
    client.timer = setInterval(() => {
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
async function send(client, type, payload = {}, original = null) {
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
  client.socket.send(JSON.stringify(command));
  await until(() => client.acks.has(command.commandId), `${type} ACK`, 10000);
  return { command, reply: client.acks.get(command.commandId) };
}
async function foreignEntry() {
  const { ticket } = await api('b', 'enter', {
    index: 3,
    mode: 'foreign',
    operationId: crypto.randomUUID(),
  });
  const response = await fetch(`${origins.a}/api/v1/participation/exchange`, {
    method: 'POST',
    headers: { Origin: origins.a, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  assert.equal(
    response.status,
    200,
    `exchange HTTP ${response.status} ${body.code ?? ''}`,
  );
  return {
    reservationId: body.reservationId,
    cookie: response.headers.get('set-cookie').split(';')[0],
  };
}
async function match(cohort, mode, presenter = null) {
  const first = cohort[0];
  await until(() => first.state.phase === 'REVEALING', `${mode} start`);
  const players = mode === 'ranked' ? (rankedOnly ? 2 : 4) : 8;
  assert.equal(first.state.playersRequired, players);
  assert.equal(first.state.players.length, players + (presenter ? 1 : 0));
  if (presenter)
    assert.equal((await send(presenter, 'buzz')).reply.code, 'PRESENTER_CANNOT_ANSWER');
  let questionNumber = 0,
    tested = false;
  while (!['FINISHED', 'INVALID'].includes(first.state.phase)) {
    await until(
      () =>
        ['FINISHED', 'INVALID'].includes(first.state.phase) ||
        (first.state.phase === 'REVEALING' &&
          first.state.questionNumber > questionNumber &&
          first.state.text.length >= 12),
      `${mode} question`,
      30000,
    );
    if (['FINISHED', 'INVALID'].includes(first.state.phase)) break;
    questionNumber = first.state.questionNumber;
    const question = questions.find((question) =>
      question.text.startsWith(first.state.text),
    );
    assert(question, `${mode} fixture question not recognized`);
    const answerers = cohort.filter((client) => client !== presenter),
      wanted = answerers[(report[mode].games + questionNumber) % answerers.length],
      buzz = await send(wanted, 'buzz');
    assert(buzz.reply.ok, `buzz ${buzz.reply.code}`);
    await until(() => wanted.panel, 'answer panel');
    for (const letter of Array.from(question.answer)) {
      const panel = wanted.panel;
      assert(panel, 'answer panel missing');
      const choice = panel.choices.find((choice) => choice.text === letter);
      assert(choice, 'fixture answer not in panel');
      const chosen = await send(wanted, 'choose', {
        attemptId: panel.attemptId,
        panelId: panel.panelId,
        choiceId: choice.id,
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
      reconnect.close();
      const restored = await open(
        reconnect.index,
        reconnect.entry,
        'game',
        reconnect.foreign,
      );
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
      );
      const next = await send(presenter, 'next');
      assert(next.reply.ok, `presenter next ${next.reply.code}`);
    }
  }
  assert.equal(first.state.phase, 'FINISHED', `${mode} invalidated`);
  await until(
    () => first.state.result?.storage === 'confirmed',
    `${mode} result saved`,
    30000,
  );
  const resultId = first.state.result.id;
  await until(
    () => cohort.every((client) => client.state.result?.id === resultId),
    'cohort result consistency',
  );
  report[mode].games++;
  return resultId;
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
    const resultId = await match(cohort, 'ranked');
    const delivery = {
      resultId,
      finishedAt: cohort[0].state.result.finishedAt,
      confirmedAt: Date.now(),
      historyAt: null,
    };
    report.ranked.deliveries.push(delivery);
    for (const client of cohort) client.close();
    const deadline = Date.now() + 90000;
    while (true) {
      const page = await api('b', 'history', { index: 3 });
      if (page.history.some((entry) => entry.resultId === resultId)) {
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
  async function recoverLobbies() {
    for (let index = 0; index < lobbies.length; index++) {
      const client = lobbies[index];
      if (client.socket.readyState === WebSocket.OPEN) continue;
      client.close();
      const deadline = Date.now() + 30000;
      while (true) {
        try {
          const restored = await open(client.index, client.entry, 'lobby');
          assert.equal(
            restored.lobby.id,
            client.entry.room,
            'reconnect changed parent room',
          );
          lobbies[index] = restored;
          report.room.transportRecoveries++;
          console.log(
            JSON.stringify({
              event: 'lobby_restored',
              at: new Date().toISOString(),
              index: client.index,
              room: restored.lobby.id,
            }),
          );
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
  while (!stopping && Date.now() < end) {
    const preparationDeadline = Date.now() + 30000;
    for (;;) {
      await recoverLobbies();
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
      if (disconnectLobbies && !disconnected) {
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
          client.intentionalClose = true;
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
        host.intentionalClose = true;
        host.socket.terminate();
        await until(
          () => lobbies.every((client) => client.socket.readyState === WebSocket.CLOSED),
          'planned lobby disconnect',
        );
        event.completedAt = new Date().toISOString();
        continue;
      }
      try {
        await api('a', 'room', {
          index: 4,
          token: lobbies[0].entry.token,
          action: 'start',
          operationId: crypto.randomUUID(),
        });
        break;
      } catch (error) {
        // A disconnect during the sequential ready calls is still recoverable.
        if (
          !error.message.includes('ROOM_NOT_READY') ||
          !lobbies.some((client) => client.socket.readyState !== WebSocket.OPEN) ||
          Date.now() >= preparationDeadline
        )
          throw error;
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
    }
    if (end === Infinity) {
      report.room.activeStartedAt = new Date().toISOString();
      end = Date.now() + minutes * 60000;
    }
    await match(cohort, 'room', cohort[0]);
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
const progress = setInterval(async () => {
  if (readingUsage) return;
  readingUsage = true;
  try {
    const usage = await cloudUsage();
    report.usage.push(usage);
    assertFreeBudget(usage);
  } catch (error) {
    stopping = true;
    report.errors.push({ message: error.message });
  } finally {
    readingUsage = false;
  }
  console.log(
    JSON.stringify({ event: 'progress', ...save(), usage: report.usage.slice(-1) }),
  );
}, 60000);
try {
  const usage = await cloudUsage();
  report.usage.push(usage);
  assertFreeBudget(usage);
  // Account registration is a separate setup step, not concurrent game traffic.
  for (const index of rankedOnly
    ? [0, 3]
    : Array.from({ length: 13 }, (_, index) => index))
    await api(index === 3 ? 'b' : 'a', 'prepare', { index });
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
  await api('a', 'config', { players: rankedOnly ? 2 : 4 });
  const fail = (error) => {
    stopping = true;
    report.errors.push({ message: error.message });
    console.log(JSON.stringify({ event: 'failure', message: error.message }));
  };
  const results = await Promise.allSettled([
    ranked().catch(fail),
    ...(rankedOnly ? [] : [rooms().catch(fail)]),
  ]);
  for (const result of results)
    if (result.status === 'rejected')
      report.errors.push({ message: result.reason.message });
} catch (error) {
  report.errors.push({ message: error.message });
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
    await api('a', 'config', { players: 2 });
    report.configRestored = true;
  } catch (error) {
    report.errors.push({ message: `restore: ${error.message}` });
  }
  const output = save();
  await writeFile(
    `.wrangler/qa/federation-load-${runId}.json`,
    `${JSON.stringify(output, null, 2)}\n`,
  );
  console.log(JSON.stringify(output));
  if (report.errors.length) process.exitCode = 1;
}
