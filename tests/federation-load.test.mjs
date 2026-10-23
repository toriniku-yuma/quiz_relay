import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { assertMatchResult } from '../scripts/federation-result-check.mjs';
import { usageDiagnostics, usageQueryError } from '../scripts/federation-usage.mjs';
import { graphemes } from '../src/worker/game/questions.ts';

const source = await readFile(
  new URL('../scripts/federation-load.mjs', import.meta.url),
  'utf8',
);
test('使用量診断は追跡IDと制限の判定を保存し、秘密を含む応答本文は捨てる', () => {
  const diagnostics = usageDiagnostics(
    {
      status: 200,
      headers: new Headers({ 'cf-ray': 'a4efd531acc47366-NRT', 'retry-after': '300' }),
    },
    {
      data: { cost: 1066666, viewer: { budget: 224, secret: 'private-value' } },
      errors: [
        {
          message: 'private-value',
          extensions: { code: 'budget', ray_id: 'a4eff69d7e32a59e-SEA' },
        },
      ],
    },
  );
  assert.deepEqual(diagnostics, {
    status: 200,
    rayId: 'a4efd531acc47366-NRT',
    errorRayIds: ['a4eff69d7e32a59e-SEA'],
    retryAfterSeconds: 300,
    budgetRejected: true,
  });
  const invalid = usageDiagnostics(
    {
      status: 429,
      headers: new Headers({ 'cf-ray': 'private-value', 'retry-after': 'private-value' }),
    },
    {
      data: { cost: 'private-value', viewer: { budget: -1 } },
      errors: [{ extensions: { code: 'private-value', ray_id: 'private-value' } }],
    },
  );
  assert.equal(invalid.rayId, null);
  assert.deepEqual(invalid.errorRayIds, []);
  assert.equal(invalid.retryAfterSeconds, null);
  assert(!JSON.stringify(invalid).includes('private-value'));
});
test('診断の書込み成否を記録して進行を維持し、切断後にheartbeatを残さない', async () => {
  for (const mode of ['sent', 'callback_failure', 'throw', 'closed']) {
    const closeBeforeTimer = mode === 'closed';
    const events = [];
    const timers = new Set();
    class Socket extends EventEmitter {
      static OPEN = 1;
      static CLOSED = 3;
      static instances = [];
      readyState = 0;
      constructor() {
        super();
        Socket.instances.push(this);
        setImmediate(() => {
          this.readyState = Socket.OPEN;
          this.emit('open');
          this.emit(
            'message',
            JSON.stringify({ type: 'lobby', room: { settings: { presenter: true } } }),
          );
        });
      }
      send(_value, callback) {
        if (!callback) return;
        if (mode === 'throw') throw new Error('private-value');
        callback(
          mode === 'callback_failure' || closeBeforeTimer
            ? new Error('private-value')
            : undefined,
        );
      }
      close() {
        this.readyState = Socket.CLOSED;
        this.emit('close', 1006, Buffer.from(''));
      }
    }
    const openSocket = vm.runInNewContext(
      `${source.slice(source.indexOf('async function openSocket('), source.indexOf('\nasync function savedSnapshot('))}; openSocket`,
      {
        Date,
        Math,
        JSON,
        URLSearchParams,
        crypto,
        once,
        WebSocket: Socket,
        origins: { a: 'https://local.test' },
        tokens: { a: 'test' },
        runId: 'test',
        clients: new Set(),
        connection: { connectTimeoutMs: 10000 },
        transportUrl: (url) => url,
        console: { log() {} },
        report: { transportEvents: events, errors: [] },
        setInterval: () => {
          const timer = {};
          timers.add(timer);
          return timer;
        },
        clearInterval: (timer) => timers.delete(timer),
        until: async (predicate) => {
          assert(predicate());
          if (closeBeforeTimer) Socket.instances[0].close();
        },
      },
    );
    const client = await openSocket(
      4,
      { room: 'room', token: 'test' },
      'lobby',
      null,
      null,
      Date.now() + 30000,
    );
    assert.equal(timers.size, closeBeforeTimer ? 0 : 1);
    assert.equal(
      events.filter(
        (event) =>
          event.event ===
          (mode === 'sent' ? 'connection_report_sent' : 'connection_report_send_failed'),
      ).length,
      1,
    );
    assert(!JSON.stringify(events).includes('private-value'));
    Socket.instances[0].close();
    assert.equal(timers.size, 0);
    client.close();
  }
});

test('使用量APIの制限は短間隔で再要求せず、分類を残して停止する', async () => {
  const usageSource = await readFile(
    new URL('../scripts/federation-usage.mjs', import.meta.url),
    'utf8',
  );
  for (const [status, errors, attempts, code, invalidJson] of [
    [
      200,
      [{ message: 'rate limiter budget depleted private-value' }],
      1,
      'RATE_LIMIT_BUDGET',
    ],
    [
      429,
      [{ message: 'query consumed excessive resources private-value' }],
      1,
      'RATE_LIMIT_RESOURCES',
    ],
    [
      429,
      [
        {
          message:
            'in combination, your request queries too many nodes, zones and accounts',
        },
      ],
      1,
      'RATE_LIMIT_QUERY_NODES',
    ],
    [429, [], 1, 'RATE_LIMIT'],
    [429, null, 1, 'RATE_LIMIT', true],
    [503, [{ message: 'service unavailable private-value' }], 3, 'API_ERROR'],
  ]) {
    let calls = 0,
      pauses = 0;
    const usage = vm.runInNewContext(
      `${usageSource.slice(usageSource.indexOf('export async function cloudUsage'), usageSource.indexOf('export function assertFreeBudget')).replace('export ', '')}; cloudUsage`,
      {
        path,
        Date,
        JSON,
        Error,
        Object,
        AbortSignal,
        usageQueryError,
        usageDiagnostics,
        account: 'test',
        process: { env: { APPDATA: '.' } },
        readFile: async () => 'oauth_token = "private-value"',
        pause: async () => {
          pauses++;
        },
        fetch: async () => {
          calls++;
          return {
            status,
            ok: status === 200,
            headers: new Headers({ 'cf-ray': 'a4efd531acc47366-NRT' }),
            json: async () => {
              if (invalidJson) throw new SyntaxError('private-value');
              return { errors };
            },
          };
        },
      },
    );
    await assert.rejects(usage(), (error) => {
      assert.equal(error.diagnostics.length, attempts);
      assert(
        error.diagnostics.every(
          (request, index) =>
            request.attempt === index + 1 &&
            request.rateLimitMode === 'account-based' &&
            request.rayId === 'a4efd531acc47366-NRT' &&
            Number.isFinite(Date.parse(request.startedAt)) &&
            Number.isFinite(Date.parse(request.finishedAt)),
        ),
      );
      assert(!JSON.stringify(error.diagnostics).includes('private-value'));
      return error.message.includes(code) && !error.message.includes('private-value');
    });
    assert.equal(calls, attempts);
    assert.equal(pauses, attempts - 1);
  }
});

test('使用量取得が再試行で成功しても、失敗したHTTP試行を診断から落とさない', async () => {
  const usageSource = await readFile(
    new URL('../scripts/federation-usage.mjs', import.meta.url),
    'utf8',
  );
  let calls = 0;
  let pauses = 0;
  const usage = vm.runInNewContext(
    `${usageSource.slice(usageSource.indexOf('export async function cloudUsage'), usageSource.indexOf('export function assertFreeBudget')).replace('export ', '')}; cloudUsage`,
    {
      path,
      Date,
      JSON,
      Error,
      Object,
      AbortSignal,
      usageQueryError,
      usageDiagnostics,
      account: 'test',
      process: { env: { APPDATA: '.' } },
      readFile: async () => 'oauth_token = "private-value"',
      pause: async () => {
        pauses++;
      },
      fetch: async (_url, init) => {
        const query = JSON.parse(init.body).query;
        assert.equal(init.headers['X-Rate-Limit-Type'], 'account-based');
        assert(!/\bcost\b|\bbudget\b/.test(query));
        calls++;
        const success = calls === 2;
        return {
          status: success ? 200 : 503,
          ok: success,
          headers: new Headers({ 'cf-ray': 'a4efd531acc47366-NRT' }),
          json: async () =>
            success
              ? {
                  data: {
                    viewer: {
                      accounts: [
                        {
                          d1AnalyticsAdaptiveGroups: [
                            { sum: { rowsRead: 1, rowsWritten: 2 } },
                          ],
                          workersInvocationsAdaptive: [
                            { sum: { requests: 3, errors: 0 } },
                          ],
                          durableObjectsInvocationsAdaptiveGroups: [
                            { sum: { requests: 4, errors: 0 } },
                          ],
                          durableObjectsPeriodicGroups: [
                            {
                              sum: {
                                duration: 5,
                                rowsRead: 6,
                                rowsWritten: 7,
                                exceededCpuErrors: 0,
                                exceededMemoryErrors: 0,
                                fatalInternalErrors: 0,
                              },
                            },
                          ],
                        },
                      ],
                    },
                  },
                  errors: null,
                }
              : { errors: [{ message: 'service unavailable private-value' }] },
        };
      },
    },
  );
  const result = await usage();
  assert.equal(calls, 2);
  assert.equal(pauses, 1);
  assert.equal(result.d1.rowsRead, 1);
  assert.equal(result.workers.requests, 3);
  assert.equal(result.durableObjects.rowsWritten, 7);
  const diagnostics = result.analytics.diagnostics;
  assert(diagnostics.every((request) => request.rateLimitMode === 'account-based'));
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].failure, 'API_ERROR');
  assert.equal(diagnostics[0].status, 503);
  assert.equal(diagnostics[1].status, 200);
  assert.equal(diagnostics[1].failure, undefined);
  assert(diagnostics.every((request) => Number.isFinite(Date.parse(request.finishedAt))));
  assert(!JSON.stringify(result).includes('private-value'));
});

const rooms = source.slice(
  source.indexOf('async function rooms()'),
  source.indexOf('\nfunction save()'),
);

test('初回の一時的な接続失敗は同じ参加情報で復旧し、失敗と復旧を両方記録する', async () => {
  let now = 0;
  const calls = [],
    logs = [],
    events = [];
  const entry = { room: 'room', token: 'private-value' },
    foreign = { reservationId: 'reservation' };
  const client = { transportEvent: (event) => events.push(event) };
  const open = vm.runInNewContext(
    `${source.slice(source.indexOf('async function open('), source.indexOf('\nasync function openSocket('))}; open`,
    {
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      connection: { retryWindowMs: 30000, retryIntervalMs: 1500 },
      stopping: false,
      report: { transportEvents: events },
      console: { log: (value) => logs.push(value) },
      pause: async (ms) => {
        now += ms;
      },
      openSocket: async (...args) => {
        calls.push(args);
        if (calls.length === 1)
          throw Object.assign(new Error('private-value'), { code: 'ECONNRESET' });
        return client;
      },
    },
  );
  assert.equal(await open(4, entry, 'game', foreign), client);
  assert.equal(calls.length, 2);
  assert(
    calls.every((call) => call[1] === entry && call[3] === foreign && call[5] === 30000),
  );
  assert.deepEqual(
    events.map((event) => event.event),
    ['socket_connect_retry', 'socket_connect_recovered'],
  );
  assert(!JSON.stringify({ events, logs }).includes('private-value'));
});

test('接続失敗が続く場合は期限で失敗し、認証拒否と未知の例外は再試行しない', async () => {
  for (const failure of [
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    new Error('Unexpected server response: 403'),
    new Error('programming error'),
  ]) {
    let now = 0,
      calls = 0;
    const open = vm.runInNewContext(
      `${source.slice(source.indexOf('async function open('), source.indexOf('\nasync function openSocket('))}; open`,
      {
        Date: class extends Date {
          static now() {
            return now;
          }
        },
        connection: { retryWindowMs: 30000, retryIntervalMs: 1500 },
        stopping: false,
        report: { transportEvents: [] },
        console: { log() {} },
        pause: async (ms) => {
          now += ms;
        },
        openSocket: async () => {
          calls++;
          throw failure;
        },
      },
    );
    await assert.rejects(
      open(4, { room: 'room' }, 'lobby', null, null, 3000),
      (error) => error === failure,
    );
    assert.equal(calls, failure.code === 'ECONNRESET' ? 2 : 1);
    assert(now < 3000);
  }
});

test('HTTP通信失敗は原因コードとパスを残し、秘密や例外本文を記録せず元の失敗を返す', async () => {
  const failure = new TypeError('private-value', {
    cause: {
      code: 'UND_ERR_SOCKET',
      errors: [{ code: 'ECONNRESET' }, { code: 'private-value' }],
    },
  });
  const report = { transportEvents: [] },
    logs = [];
  const request = vm.runInNewContext(
    `${source.slice(source.indexOf('const request ='), source.indexOf('\nconst questions ='))}; request`,
    {
      fetch: async () => {
        throw failure;
      },
      transportUrl: (value) => value,
      performance: { now: () => 10 },
      Date,
      URL,
      report,
      console: { log: (value) => logs.push(value) },
    },
  );
  await assert.rejects(
    request('https://qa.example/api/join?token=private-value', {
      method: 'POST',
      headers: { Authorization: 'private-value' },
      body: 'private-value',
    }),
    (error) => error === failure,
  );
  const [event] = JSON.parse(JSON.stringify(report.transportEvents));
  assert.equal(event.path, '/api/join');
  assert.equal(event.code, 'UND_ERR_SOCKET');
  assert.equal(event.errorType, 'TypeError');
  assert.deepEqual(event.causes, ['ECONNRESET']);
  assert(!JSON.stringify({ report, logs }).includes('private-value'));
});

test('API失敗は操作と追跡IDを残し、入力や応答全体を記録せず試験を失敗させる', async () => {
  const report = { transportEvents: [] },
    logs = [],
    operationId = '11111111-1111-4111-8111-111111111111',
    headers = new Headers({ 'cf-ray': '1234567890abcdef-NRT' });
  const api = vm.runInNewContext(
    `${source.slice(source.indexOf('async function api('), source.indexOf('\nasync function until('))}; api`,
    {
      request: async () => ({
        status: 500,
        headers,
        json: async () => ({ code: 'INTERNAL', detail: 'private-value' }),
      }),
      origins: { a: 'https://qa.example' },
      tokens: { a: 'private-value' },
      runId: operationId,
      AbortSignal,
      assert,
      report,
      console: { log: (value) => logs.push(value) },
    },
  );
  await assert.rejects(
    api('a', 'room', { index: 4, action: 'return', operationId, token: 'private-value' }),
    /a\/room HTTP 500 INTERNAL/,
  );
  assert.equal(report.transportEvents[0].action, 'return');
  assert.equal(report.transportEvents[0].operationId, operationId);
  assert.equal(report.transportEvents[0].index, 4);
  assert.equal(report.transportEvents[0].ray, '1234567890abcdef-NRT');
  headers.set('cf-ray', 'private-value');
  await assert.rejects(
    api('a', 'room', {
      index: 'private-value',
      action: 'private-value',
      operationId: 'private-value',
    }),
  );
  assert(!JSON.stringify({ report, logs }).includes('private-value'));
});

test('local transport keeps signed identities but routes HTTP and WebSocket only to loopback', () => {
  const transport = vm.runInNewContext(
    `${source.slice(source.indexOf('function transportUrl('), source.indexOf('\nconst request ='))}; transportUrl`,
    {
      assert,
      URL,
      origins: { a: 'https://a.example.test', b: 'https://b.example.test' },
      local: {
        endpoints: { a: 'http://127.0.0.1:4567/a', b: 'http://127.0.0.1:4567/b' },
      },
    },
  );
  assert.equal(
    transport('https://b.example.test/api/join?reservation=one'),
    'http://127.0.0.1:4567/b/api/join?reservation=one',
  );
  assert.equal(
    transport('wss://a.example.test/api/socket?connection=two'),
    'ws://127.0.0.1:4567/a/api/socket?connection=two',
  );
  assert.throws(
    () => transport('https://outside.example.test/'),
    /unknown local destination/,
  );
  assert.throws(() => transport('http://a.example.test/'), /unknown local destination/);
});

test('毎分の進捗出力は使用量を連打せず、5分後の照会失敗では負荷を停止する', async () => {
  let now = 0;
  let tick;
  let reads = 0;
  const report = { usage: [], errors: [] };
  const context = vm.createContext({
    local: null,
    stopping: false,
    report,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    cloudUsage: async () => {
      reads++;
      if (reads === 2) throw new Error('RATE_LIMIT_BUDGET');
      return { checkedAt: now };
    },
    assertFreeBudget() {},
    save: () => ({}),
    console: { log() {} },
    setInterval(callback, interval) {
      assert.equal(interval, 60000);
      tick = callback;
    },
  });
  vm.runInContext(
    source.slice(
      source.indexOf('let readingUsage = false;'),
      source.indexOf('\ntry {\n  if (!local) {'),
    ),
    context,
  );
  // The initial usage check schedules the first periodic check five minutes later.
  vm.runInContext('nextUsageAt = Date.now() + usageIntervalMs;', context);
  for (now = 60000; now < 300000; now += 60000) await tick();
  assert.equal(reads, 0);
  await tick();
  assert.equal(reads, 1);
  for (now = 360000; now < 600000; now += 60000) await tick();
  assert.equal(reads, 1);
  await tick();
  assert.equal(reads, 2);
  assert.equal(context.stopping, true);
  assert.equal(report.errors[0].message, 'RATE_LIMIT_BUDGET');
  now = 900000;
  await tick();
  assert.equal(reads, 2, '停止後に照会を繰り返さない');
});

test('終了処理は進行中の使用量照会を待ち、遅れて返る失敗も保存して失敗終了する', async () => {
  for (const rejected of [false, true]) {
    let tick;
    let settle;
    let written;
    let closed = false;
    const report = { usage: [], errors: [] };
    const context = vm.createContext({
      local: null,
      stopping: false,
      report,
      Date,
      cloudUsage: () =>
        new Promise((resolve, reject) => {
          settle = () =>
            rejected ? reject(new Error('RATE_LIMIT_BUDGET')) : resolve({ requests: 1 });
        }),
      assertFreeBudget() {},
      save: () => structuredClone(report),
      console: { log() {} },
      setInterval(callback) {
        tick = callback;
      },
      clearInterval() {},
      clients: [
        {
          close: () => {
            closed = true;
          },
        },
      ],
      originalPeerState: undefined,
      roomsOnly: false,
      api: async () => ({}),
      writeFile: async (_path, contents) => {
        written = JSON.parse(contents);
      },
      runId: 'test',
      process: {},
    });
    vm.runInContext(
      source.slice(
        source.indexOf('let readingUsage = false;'),
        source.indexOf('\ntry {\n  if (!local) {'),
      ),
      context,
    );
    const checking = tick();
    const finishing = vm.runInContext(
      `(async () => {${source.slice(source.indexOf('\n  stopping = true;\n  clearInterval(progress);'), source.lastIndexOf('}'))}})()`,
      context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, true, '使用量の応答待ちでも接続の終了処理は進める');
    assert.equal(written, undefined, '照会の完了前に最終レポートを保存しない');
    settle();
    await Promise.all([checking, finishing]);
    assert.equal(written.configRestored, true);
    assert.equal(written.errors.length, rejected ? 1 : 0);
    assert.equal(written.usage.length, rejected ? 0 : 1);
    assert.equal(context.process.exitCode, rejected ? 1 : undefined);
  }
});

test('操作と状態待ちは指定した参加者だけを復旧し、別試合の復旧に巻き込まれない', async () => {
  let release;
  const recovery = new Promise((resolve) => {
    release = resolve;
  });
  let sends = 0;
  const client = {
    kind: 'game',
    ready: true,
    state: { matchId: 'ranked', questionId: 'question', roomSeq: 1 },
    lastReceivedAt: new Date().toISOString(),
    acks: new Map(),
    pending: new Map(),
    inflight: new Map(),
    socket: {
      readyState: 1,
      send(value) {
        sends++;
        client.acks.set(JSON.parse(value).commandId, { ok: true, roomSeq: 1 });
      },
    },
  };
  const other = { state: { matchId: 'room' }, recovering: recovery };
  const recovered = [];
  const { send, until } = vm.runInNewContext(
    `${source.slice(source.indexOf('async function until('), source.indexOf('\nasync function open('))}
    ${source.slice(source.indexOf('async function recoverGames('), source.indexOf('\nfunction cutGame('))}
    ${source.slice(source.indexOf('async function send('), source.indexOf('\nlet foreignLogin;'))}
    ; ({send, until})`,
    {
      clients: new Set([client, other]),
      connection: { receiveTimeoutMs: 60000, retryWindowMs: 30000 },
      WebSocket: { OPEN: 1 },
      commands: 0,
      stopping: false,
      crypto: { randomUUID: () => 'command' },
      performance,
      pause: async () => {},
      recoverGame: (target) => {
        recovered.push(target);
        return target.recovering;
      },
    },
  );
  try {
    const operation = send(client, 'choose');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends, 1, '別試合が復旧中でも回答を送信する');
    assert.equal((await operation).reply.ok, true);
    await until(() => true, 'ranked state', 1000, [client]);
    await until(() => true, 'lobby state');
    assert.equal(recovered.length, 0);

    client.recovering = recovery;
    let ready = false;
    const waiting = until(() => true, 'own recovery', 1000, [client]).then(() => {
      ready = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false, '対象自身の復旧は完了まで待つ');
    assert.deepEqual(recovered, [client]);
    release();
    await waiting;
    assert.equal(ready, true);
  } finally {
    release();
  }
});

test('an ACK does not advance the load client until its corresponding state arrives', async () => {
  const client = {
    state: { matchId: 'match', questionId: 'question', roomSeq: 10 },
    acks: new Map(),
    pending: new Map(),
    inflight: new Map(),
    socket: {
      send(value) {
        const command = JSON.parse(value);
        client.acks.set(command.commandId, { ok: true, roomSeq: 11 });
      },
    },
  };
  const send = vm.runInNewContext(
    `${source.slice(source.indexOf('async function send('), source.indexOf('\nlet foreignLogin;'))}; send`,
    {
      commands: 0,
      stopping: false,
      crypto: { randomUUID: () => 'command' },
      performance: { now: () => 0 },
      connection: { retryWindowMs: 30000 },
      recoverGames: async () => {},
      until: async (predicate) => {
        assert.equal(Boolean(predicate()), false, 'ACK alone must not satisfy the wait');
        client.state.roomSeq = 11;
        assert.equal(Boolean(predicate()), true);
      },
    },
  );
  assert.equal((await send(client, 'choose')).reply.roomSeq, 11);
});

test('fixture recognition uses the same normalized display text even when the full question arrives', () => {
  const questions = [
    {
      id: 'mock-06',
      text: '夜空に見え、地球のまわりを回っている天然の衛星は何でしょう？',
    },
  ];
  const expression = source.slice(
    source.indexOf('const question = questions.find('),
    source.indexOf('    assert(question,'),
  );
  for (const text of ['夜空に見え、地球のまわり', questions[0].text.normalize('NFKC')]) {
    assert.equal(
      vm.runInNewContext(`${expression}; question`, {
        questions,
        graphemes,
        first: { state: { text } },
      }),
      questions[0],
    );
  }
});

test('expired answer windows fail immediately with their state instead of waiting for a missing panel', async () => {
  const events = [];
  const wanted = {
    index: 1,
    actorId: 'foreign-actor',
    state: {
      questionId: 'question',
      phase: 'JUDGED',
      holder: null,
      deadline: 123,
      judgment: { result: 'timeout' },
    },
    panel: null,
    transportEvent: (event) => events.push(event),
  };
  const wait = vm.runInNewContext(
    `(async () => { ${source.slice(source.indexOf('    await until(', source.indexOf('assert(buzz.reply.ok')), source.indexOf('    for (const letter of Array.from(question.answer))'))} })`,
    {
      wanted,
      buzz: { command: { commandId: 'buzz', questionId: 'question' } },
      mode: 'room',
      until: async (predicate) => predicate(),
    },
  );
  await assert.rejects(wait(), /room: answer window lost after buzz ACK/);
  assert.equal(events[0].event, 'answer_window_lost');
  assert.equal(events[0].commandId, 'buzz');
  assert.equal(events[0].judgment.result, 'timeout');
  wanted.state.phase = 'ANSWERING';
  wanted.state.holder = 'foreign-actor';
  wanted.panel = { panelId: 'panel' };
  await wait();
  assert.equal(events.length, 1);
});

test('delivery comparison rejects changes to final outcome and every player', () => {
  const expected = {
    matchId: 'match',
    reason: 'exhausted',
    winnerId: 'a',
    finishedAt: 10,
    players: [
      { id: 'a', correct: 7, mistakes: 1, disqualified: false },
      { id: 'b', correct: 2, mistakes: 3, disqualified: true, forfeited: true },
      { id: 'c', correct: 0, mistakes: 0, disqualified: false, role: 'presenter' },
    ],
  };
  assertMatchResult(expected, structuredClone(expected));
  for (const [field, value] of [
    ['reason', 'connections'],
    ['winnerId', 'b'],
    ['finishedAt', 11],
  ]) {
    assert.throws(() => assertMatchResult(expected, { ...expected, [field]: value }), {
      code: 'ERR_ASSERTION',
    });
  }
  for (const [field, value] of [
    ['correct', 0],
    ['mistakes', 0],
    ['disqualified', false],
    ['forfeited', false],
    ['role', 'presenter'],
  ]) {
    const changed = structuredClone(expected);
    changed.players[1][field] = value;
    assert.throws(() => assertMatchResult(expected, changed), { code: 'ERR_ASSERTION' });
  }
});

test('saved result must preserve every player correct-answer count', async () => {
  const matchSource = source.slice(
    source.indexOf('async function match('),
    source.indexOf('\nasync function ranked('),
  );
  async function verify(savedCorrect) {
    const state = {
      phase: 'REVEALING',
      matchId: 'match',
      playersRequired: 4,
      players: Array.from({ length: 4 }, (_, index) => ({
        id: String(index),
        correct: index === 0 ? 3 : 0,
        mistakes: 0,
        disqualified: false,
      })),
      result: { storage: 'confirmed' },
    };
    const saved = structuredClone(state);
    saved.players[0].correct = savedCorrect;
    const report = { ranked: { games: 0 } };
    const run = vm.runInNewContext(`${matchSource}; match`, {
      assert,
      assertMatchResult,
      rankedOnly: false,
      disconnectBoundaries: false,
      report,
      until: async (predicate) => {
        assert(predicate());
        state.phase = 'FINISHED';
      },
      api: async () => ({ history: [{ snapshot: saved }] }),
    });
    await run([{ index: 0, state }], 'ranked');
    assert.equal(report.ranked.games, 1);
  }
  await verify(3);
  await assert.rejects(verify(0), { code: 'ERR_ASSERTION' });
});

async function scenario(disconnect) {
  let now = 0,
    starts = 0,
    games = 0;
  const clients = new Map();
  const lobby = {
    id: 'room',
    hostId: 'actor-4',
    revision: 0,
    playing: false,
    matchRoom: null,
    settings: { presenter: true, capacity: 8 },
  };
  const report = { room: { transportRecoveries: 0 }, transportEvents: [] };
  const api = async (_node, route, input) => {
    now += 2000;
    if (route === 'enter') return { token: String(input.index) };
    if (input.action === 'start') {
      starts++;
      if (disconnect && starts === 1) {
        clients.get(5).socket.readyState = 3;
        lobby.members = [{ id: 'actor-5', connected: false, ready: true }];
        throw new Error('ROOM_NOT_READY');
      }
    }
    if (input.action === 'session') return { room: 'game' };
    return { lobby };
  };
  const open = async (index, entry, kind) => {
    const client = { index, entry, lobby, socket: { readyState: 1 }, close() {} };
    if (kind === 'lobby') clients.set(index, client);
    return client;
  };
  const run = vm.runInNewContext(`${rooms}; rooms`, {
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    crypto: { randomUUID: () => 'operation' },
    WebSocket: { OPEN: 1 },
    console: { log() {} },
    assert,
    runId: 'room',
    minutes: 1,
    stopping: false,
    disconnectHost: false,
    disconnectBoundaries: false,
    disconnectLobbies: false,
    actors: new Map(Array.from({ length: 9 }, (_, i) => [i + 4, `actor-${i + 4}`])),
    report,
    api,
    open,
    match: async () => {
      games++;
      now += disconnect ? 60000 : 30000;
    },
    pause: async (milliseconds) => {
      now += milliseconds;
    },
    until: async (predicate) => assert(predicate()),
  });
  await run();
  assert.equal(
    report.transportEvents.filter((event) => event.event === 'lobby_restored').length,
    report.room.transportRecoveries,
    '復旧件数に対応する接続情報を最終レポートへ保存する',
  );
  return { starts, games, recoveries: report.room.transportRecoveries };
}

test('sequential preparation does not consume the disconnect recovery deadline', async () => {
  assert.deepEqual(await scenario(true), { starts: 2, games: 1, recoveries: 1 });
});

test('does not start a new match when the duration expires during preparation', async () => {
  assert.deepEqual(await scenario(false), { starts: 1, games: 1, recoveries: 0 });
});

function recoveryScenario(saved, reopen) {
  let now = 100000;
  const events = [];
  const clients = new Set();
  const client = {
    index: 2,
    connectionId: crypto.randomUUID(),
    kind: 'game',
    ready: true,
    intentionalClose: false,
    entry: { room: 'match', token: 'session' },
    foreign: null,
    state: { matchId: 'match', phase: 'ANSWERING', result: null },
    socket: { readyState: 3 },
    lastReceivedAt: new Date(now).toISOString(),
    close() {
      client.intentionalClose = true;
      clients.delete(client);
    },
    transportEvent(event) {
      events.push(event.event);
    },
  };
  clients.add(client);
  let attempts = 0,
    reads = 0;
  const functions = vm.runInNewContext(
    `${source.slice(source.indexOf('async function recoverGame('), source.indexOf('\nasync function send('))}; ({recoverGame, recoverGames})`,
    {
      assert,
      clients,
      WebSocket: { OPEN: 1 },
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      connection: {
        retryWindowMs: 30000,
        retryIntervalMs: 1500,
        receiveTimeoutMs: 15000,
      },
      savedSnapshot: async () => {
        reads++;
        return saved;
      },
      open: async (index, entry, kind, foreign, existing) => {
        attempts++;
        assert.equal(index, client.index);
        assert.equal(kind, 'game');
        assert.equal(foreign, client.foreign);
        assert.equal(existing, client);
        assert.equal(entry, client.entry);
        await reopen?.(existing);
        existing.intentionalClose = false;
        existing.socket.readyState = 1;
      },
      pause: async (ms) => {
        now += ms;
      },
    },
  );
  return { ...functions, client, clients, events, counts: () => ({ attempts, reads }) };
}

test('a lost final message is restored from D1 before waiting for cohort completion', async () => {
  const final = { matchId: 'match', phase: 'FINISHED', result: { storage: 'confirmed' } };
  const scenario = recoveryScenario(final);
  await scenario.recoverGames([scenario.client]);
  assert.equal(scenario.client.state, final);
  assert.equal(scenario.client.resultRecovered, true);
  assert.deepEqual(scenario.counts(), { attempts: 0, reads: 1 });
  assert.deepEqual(scenario.events, ['game_recovery_started', 'game_result_restored']);
});

test('concurrent waiters share one reconnection and preserve the participant object', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const scenario = recoveryScenario(null, () => pending);
  const first = scenario.recoverGame(scenario.client);
  const second = scenario.recoverGames([scenario.client]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(scenario.counts(), { attempts: 1, reads: 1 });
  assert.equal(scenario.client.state.matchId, 'match');
  assert.equal(scenario.client.socket.readyState, 1);
  assert.equal(
    scenario.client.connectionFailure.connectionId,
    scenario.client.connectionId,
  );
  assert.equal(scenario.client.connectionFailure.trigger, 'close');
  assert.equal(scenario.client.connectionFailure.at, 100000);
  assert.equal(scenario.client.connectionFailure.closeCode, undefined);
});

test('boundary injection waits for a live peer to confirm saving, then reads D1', async () => {
  const final = { matchId: 'match', phase: 'FINISHED', result: { storage: 'confirmed' } };
  const scenario = recoveryScenario(final);
  scenario.client.holdUntilSaved = true;
  const peer = {
    kind: 'game',
    ready: true,
    state: { matchId: 'match', result: null },
    socket: { readyState: 1 },
    lastReceivedAt: new Date(100000).toISOString(),
  };
  scenario.clients.add(peer);
  await scenario.recoverGames([scenario.client]);
  assert.equal(scenario.counts().reads, 0);
  peer.state = final;
  await scenario.recoverGames([scenario.client]);
  assert.equal(scenario.client.state, final);
  assert.equal(scenario.counts().reads, 1);
});

test('recovery fails after its retry window and never switches to another match', async () => {
  const unavailable = recoveryScenario(null, () => {
    throw new Error('unavailable');
  });
  await assert.rejects(unavailable.recoverGames([unavailable.client]), /unavailable/);
  assert.equal(unavailable.counts().attempts, 21);
  const wrong = recoveryScenario(null, (client) => {
    client.state.matchId = 'other';
  });
  await assert.rejects(wrong.recoverGames([wrong.client]), /reconnect changed match/);
  assert.equal(wrong.counts().attempts, 1);
});

test('an OPEN socket with no received state is also reconnected', async () => {
  const scenario = recoveryScenario(null);
  scenario.client.socket.readyState = 1;
  scenario.client.lastReceivedAt = new Date(84000).toISOString();
  await scenario.recoverGames([scenario.client]);
  assert.equal(scenario.counts().attempts, 1);
  assert.equal(scenario.client.connectionFailure.trigger, 'receive_timeout');
  assert.equal(scenario.client.connectionFailure.lastStateAgeMs, 16000);
});
