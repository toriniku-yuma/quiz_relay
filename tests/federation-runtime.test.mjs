import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { validConnectionReport } from '../src/shared/connection-report.ts';

// Run the unchanged CLI module with local child processes and storage substituted.
const scriptUrl = new URL('../scripts/federation-runtime.mjs', import.meta.url);
const source = await readFile(scriptUrl, 'utf8');
test('復旧診断と接続例外のIDを保存し、不正な診断本文を混入させない', async () => {
  const connectionId = '11111111-1111-4111-8111-111111111111';
  const recovery = {
    connectionId: '22222222-2222-4222-8222-222222222222',
    at: 1800000000000,
    trigger: 'close',
    closeCode: 1006,
    attempts: 2,
    elapsedMs: 3000,
  };
  const { report } = await monitor(undefined, false, [
    {
      outcome: 'ok',
      logs: [
        {
          event: 'socket_client_report',
          objectId: 'a'.repeat(64),
          connectionId,
          connectMs: 20,
          recovery,
        },
        {
          event: 'socket_client_report',
          objectId: 'a'.repeat(64),
          connectionId,
          connectMs: 20,
          recovery: { ...recovery, token: 'private-value' },
        },
        {
          event: 'game_socket_failed',
          objectId: 'a'.repeat(64),
          connectionId,
          code: 'NETWORK_UNAVAILABLE',
        },
        {
          event: 'room_lobby_closed',
          objectId: 'a'.repeat(64),
          connectionId,
          reportReceived: true,
          clientReport: { type: 'connection_report', connectMs: 20, recovery },
        },
        {
          event: 'game_socket_closed',
          objectId: 'a'.repeat(64),
          connectionId,
          reportReceived: false,
          clientReport: {
            type: 'connection_report',
            connectMs: 20,
            token: 'private-value',
          },
        },
      ].map((row) => ({ message: [JSON.stringify(row)] })),
    },
  ]);
  assert.deepEqual(report.lifecycle[0].recovery, recovery);
  assert.equal(report.lifecycle[0].source, 'client');
  assert.equal(report.lifecycle[1].recovery, undefined);
  assert.equal(report.lifecycle[2].reportReceived, true);
  assert.deepEqual(report.lifecycle[2].clientReport.recovery, recovery);
  assert.equal(report.lifecycle[3].clientReport, undefined);
  assert.equal(report.events[0].diagnostics[0].connectionId, connectionId);
  assert(!JSON.stringify(report).includes('private-value'));
});

test('URLのクエリが伏せられた切断も接続ログのIDで照合できる', async () => {
  const connectionId = '11111111-1111-4111-8111-111111111111';
  const roomId = '22222222-2222-4222-8222-222222222222';
  const { report } = await monitor(undefined, false, [
    {
      outcome: 'responseStreamDisconnected',
      event: { request: { url: 'https://qa.example/api/probes/game/load/socket' } },
      logs: [
        {
          message: [
            JSON.stringify({
              event: 'load_socket_opened',
              connectionId,
              roomId,
              socketKind: 'lobby',
              token: 'private-value',
            }),
          ],
        },
      ],
    },
  ]);
  assert.equal(report.events[0].connectionId, connectionId);
  assert.equal(report.events[0].roomId, roomId);
  assert.equal(report.events[0].socketKind, 'lobby');
  assert(!JSON.stringify(report).includes('private-value'));
});

test('日次処理の実行IDと各処理の結果を保持する', async () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const { report } = await monitor(undefined, false, [
    {
      outcome: 'ok',
      logs: ['ok', 'pending', 'failed'].map((outcome, taskIndex) => ({
        message: [
          JSON.stringify({
            event: 'maintenance_task',
            task: 'results',
            phase: 'end',
            at: 1800000000000,
            runId,
            taskIndex,
            frequency: 'daily',
            outcome,
            secret: 'private-value',
          }),
        ],
      })),
    },
  ]);
  assert.deepEqual(
    report.maintenance.map((row) => row.outcome),
    ['ok', 'pending', 'failed'],
  );
  assert.deepEqual(
    report.maintenance.map((row) => row.taskIndex),
    [0, 1, 2],
  );
  assert(
    report.maintenance.every((row) => row.runId === runId && row.frequency === 'daily'),
  );
  assert(!JSON.stringify(report).includes('private-value'));
});
test('外部通信の期限と相手HTTP状態を記録し、秘密を含むパスを捨てる', async () => {
  const { report } = await monitor(undefined, false, [
    {
      outcome: 'ok',
      logs: [
        {
          message: [
            JSON.stringify({
              event: 'federation_peer_failed',
              code: 'FEDERATION_PEER_HTTP',
              peerStatus: 503,
              timeoutMs: 15000,
              elapsedMs: 5010,
              path: '/secret-value',
              body: 'secret-value',
            }),
          ],
        },
      ],
    },
  ]);
  assert.equal(report.events[0].diagnostics[0].peerStatus, 503);
  assert.equal(report.events[0].diagnostics[0].timeoutMs, 15000);
  assert.equal(report.events[0].diagnostics[0].elapsedMs, 5010);
  assert(!JSON.stringify(report).includes('secret-value'));
});
test('切断診断の段階と分類だけを保存し、生の例外を捨てる', async () => {
  const { report } = await monitor(undefined, false, [
    {
      outcome: 'ok',
      logs: [
        {
          message: [
            JSON.stringify({
              event: 'room_disconnect_failed',
              code: 'INTERNAL',
              stage: 'save',
              objectId: 'a'.repeat(64),
              markers: ['RESET', 'secret-value'],
              remote: true,
              message: 'secret-value',
              stack: 'secret-value',
              errorType: 'Error',
              locations: [
                'index.js:123:45',
                '/secret-value/index.js:1:2',
                'https://secret-value/index.js:1:2',
              ],
            }),
          ],
        },
      ],
    },
  ]);
  assert.equal(report.events[0].diagnostics[0].stage, 'save');
  assert.deepEqual(report.events[0].diagnostics[0].markers, ['RESET']);
  assert.equal(report.events[0].diagnostics[0].remote, true);
  assert.equal(report.events[0].diagnostics[0].errorType, 'Error');
  assert.deepEqual(report.events[0].diagnostics[0].locations, ['index.js:123:45']);
  assert(!JSON.stringify(report).includes('secret-value'));
});
test('参加失敗の段階と追跡IDを保持し、任意の入力値を保存しない', async () => {
  const operationId = '11111111-1111-4111-8111-111111111111';
  const { report } = await monitor(undefined, false, [
    {
      outcome: 'ok',
      logs: [
        {
          message: [
            JSON.stringify({
              event: 'federation_join_failed',
              code: 'NETWORK_UNAVAILABLE',
              stage: 'home.issue',
              operationId,
              correlationId: operationId,
              instanceId: 'private-value',
              secret: 'private-value',
            }),
          ],
        },
      ],
    },
  ]);
  assert.equal(report.events[0].diagnostics[0].stage, 'home.issue');
  assert.equal(report.events[0].diagnostics[0].operationId, operationId);
  assert.equal(report.events[0].diagnostics[0].correlationId, operationId);
  assert(!JSON.stringify(report).includes('private-value'));
});
async function monitor(failure, interrupted = false, items = [], stderr = []) {
  const children = [],
    reports = [],
    logs = [],
    listeners = new Map();
  let stop;
  const fakeProcess = {
    argv: ['node', 'federation-runtime.mjs', '1'],
    execPath: 'node',
    env: {},
    exitCode: undefined,
    on: (event, callback) => listeners.set(event, callback),
  };
  const context = createContext({
    process: fakeProcess,
    URL,
    console: { log: (line) => logs.push(JSON.parse(line)) },
    setTimeout: (callback) => {
      stop = callback;
      return 1;
    },
    clearTimeout: () => {},
    setInterval: () => 2,
    clearInterval: () => {},
  });
  const dependencies = {
    '../src/shared/connection-report.ts': { validConnectionReport },
    'node:child_process': {
      spawn: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.closed = false;
        child.kill = () => {
          if (!child.closed) {
            child.closed = true;
            child.emit('close', null, 'SIGTERM');
          }
        };
        children.push(child);
        return child;
      },
    },
    'node:fs/promises': {
      mkdir: async () => {},
      writeFile: async (_path, content) => reports.push(JSON.parse(content)),
    },
    'node:module': { createRequire: () => ({ resolve: () => 'local-wrangler-fixture' }) },
  };
  const module = new SourceTextModule(source, { context, identifier: scriptUrl.href });
  await module.link((specifier) => {
    const exports = dependencies[specifier];
    assert(exports, `Unexpected import: ${specifier}`);
    return new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context },
    );
  });
  await module.evaluate();
  for (const child of children) {
    child.stdout.emit(
      'data',
      JSON.stringify({
        outcome: 'ok',
        event: { request: { url: 'https://example.com/' }, response: { status: 200 } },
      }),
    );
  }
  for (const item of items)
    children[0].stdout.emit(
      'data',
      typeof item === 'string' ? item : JSON.stringify(item),
    );
  for (const chunk of stderr) children[0].stderr.emit('data', chunk);
  const closedBeforeStop = children[0].closed;
  if (failure !== undefined) {
    const child = children[0];
    child.stderr.emit('data', 'sensitive-fixture-do-not-save');
    if (failure === 'spawn')
      child.emit('error', new Error('sensitive-fixture-do-not-save'));
    if (failure === 'buffer') child.stdout.emit('data', `{${' '.repeat(1000001)}`);
    else {
      child.closed = true;
      child.emit('close', failure === 'spawn' ? null : failure, null);
    }
  }
  if (interrupted) listeners.get('SIGINT')();
  else stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports.length, 1);
  assert(!JSON.stringify({ reports, logs }).includes('sensitive-fixture-do-not-save'));
  return { report: reports[0], exitCode: fakeProcess.exitCode ?? 0, closedBeforeStop };
}

test('Wranglerの内部再接続を検知して対象を停止し、監視完了と扱わない', async () => {
  const { report, exitCode, closedBeforeStop } = await monitor(
    undefined,
    false,
    [],
    [
      'sensitive-fixture-do-not-save\n▲ [WARNING] Tail connection lo',
      'st. Reconnecting (attempt 1 of 5) in 1s...\n',
    ],
  );
  assert.equal(closedBeforeStop, true);
  assert.equal(report.complete, false);
  assert.equal(exitCode, 1);
  assert.equal(report.tails[0].errorCode, 'TAIL_CONNECTION_LOST');
  assert(report.tails.slice(1).every((tail) => !tail.errorCode));
});

test('終了時刻に監視を止めた場合は4対象の終了状態を保存して成功する', async () => {
  const { report, exitCode } = await monitor();
  assert.equal(exitCode, 0);
  assert.equal(report.complete, true);
  assert.equal(report.tails.length, 4);
  assert(
    report.tails.every((tail) => tail.startedAt && tail.finishedAt && !tail.errorCode),
  );
});

for (const interrupted of [false, true]) {
  test(`未完成のログを残して終了した場合は欠落を検知する 手動停止=${interrupted}`, async () => {
    const { report, exitCode } = await monitor(undefined, interrupted, [
      '{"outcome":"exception","event":',
    ]);
    assert.equal(report.complete, false);
    assert.equal(exitCode, 1);
    assert.equal(report.tails[0].errorCode, 'TAIL_INCOMPLETE_RECORD');
  });
}

test('分割して届いたJSONを最後まで受信した場合は欠落にしない', async () => {
  const { report, exitCode } = await monitor(undefined, false, [
    '{"outcome":',
    '"exception"}\n',
  ]);
  assert.equal(report.complete, true);
  assert.equal(exitCode, 0);
  assert.equal(report.events[0].outcome, 'exception');
});

test('壊れたJSONを破棄した場合も収集不完全とし、後続ログは収集する', async () => {
  const { report, exitCode } = await monitor(undefined, false, [
    '{"outcome":}',
    { outcome: 'exception' },
  ]);
  assert.equal(report.complete, false);
  assert.equal(exitCode, 1);
  assert.equal(report.tails[0].errorCode, 'TAIL_PARSE_FAILED');
  assert.equal(report.events[0].outcome, 'exception');
});

for (const event of ['match_lifecycle_failed', 'match_finish_notification_failed']) {
  test(`${event}を実行結果がokでも保存し、任意の値は除く`, async () => {
    const matchId = '11111111-1111-4111-8111-111111111111';
    const { report } = await monitor(undefined, false, [
      {
        outcome: 'ok',
        logs: [
          {
            message: [
              JSON.stringify({
                event,
                matchId,
                objectId: 'a'.repeat(64),
                code: 'INTERNAL',
                errorType: 'Error',
                locations: ['index.js:123:4'],
                message: 'private-value',
                stack: 'private-value',
              }),
            ],
          },
        ],
      },
    ]);
    assert.equal(report.events.length, 1);
    assert.equal(report.events[0].diagnostics[0].event, event);
    assert.equal(report.events[0].diagnostics[0].matchId, matchId);
    assert.deepEqual(report.events[0].diagnostics[0].locations, ['index.js:123:4']);
    assert(!JSON.stringify(report).includes('private-value'));
  });
}

for (const [stream, limit, item] of [
  [
    'events',
    1000,
    {
      outcome: 'ok',
      event: { request: { url: 'https://example.com/' }, response: { status: 500 } },
    },
  ],
  [
    'maintenance',
    1000,
    {
      outcome: 'ok',
      logs: [
        {
          message: [
            JSON.stringify({
              event: 'maintenance_task',
              task: 'results',
              phase: 'start',
              at: 1800000000000,
            }),
          ],
        },
      ],
    },
  ],
  [
    'lifecycle',
    10000,
    {
      outcome: 'ok',
      logs: [
        {
          message: [
            JSON.stringify({
              event: 'game_socket_connected',
              objectId: 'a'.repeat(64),
            }),
          ],
        },
      ],
    },
  ],
]) {
  test(`${stream}の保存上限を超えた場合だけ欠落件数を記録して監視を不完全とする`, async () => {
    for (const extra of [0, 2]) {
      const { report, exitCode } = await monitor(
        undefined,
        false,
        Array(limit + extra).fill(item),
      );
      assert.equal(report[stream].length, limit);
      assert.equal(report.dropped[stream], extra);
      assert.equal(report.complete, extra === 0);
      assert.equal(exitCode, extra === 0 ? 0 : 1);
    }
  });
}

test('結果保存の失敗は試合IDと安全な発生位置だけを記録する', async () => {
  const matchId = '11111111-1111-4111-8111-111111111111';
  const { report } = await monitor(
    undefined,
    false,
    [matchId, 'private-value'].map((id) => ({
      outcome: 'ok',
      logs: [
        {
          message: [
            JSON.stringify({
              event: 'result_save_failed',
              code: 'INTERNAL',
              matchId: id,
              objectId: 'a'.repeat(64),
              errorType: 'Error',
              locations: ['index.js:123:4'],
              message: 'private-value',
            }),
          ],
        },
      ],
    })),
  );
  assert.equal(report.events.length, 2);
  assert.equal(report.events[0].diagnostics[0].matchId, matchId);
  assert.deepEqual(report.events[0].diagnostics[0].locations, ['index.js:123:4']);
  assert(!JSON.stringify(report).includes('private-value'));
});

test('一部の監視が予定外に終了した場合は終了コード0でも監視を失敗とする', async () => {
  for (const code of [0, 1]) {
    const { report, exitCode } = await monitor(code);
    assert.equal(exitCode, 1);
    assert.equal(report.complete, false);
    assert.equal(report.tails[0].exitCode, code);
    assert.equal(report.tails[0].errorCode, 'TAIL_UNEXPECTED_EXIT');
    assert.equal(report.counts.length, 4);
  }
});

test('ユーザーが停止した監視は予定外終了にしない', async () => {
  const { report, exitCode } = await monitor(undefined, true);
  assert.equal(exitCode, 0);
  assert.equal(report.complete, true);
});

test('起動失敗とログの欠落を保存し、生のエラーや認証情報は保存しない', async () => {
  for (const [failure, code] of [
    ['spawn', 'TAIL_START_FAILED'],
    ['buffer', 'TAIL_BUFFER_LIMIT'],
  ]) {
    const { report, exitCode } = await monitor(failure);
    assert.equal(exitCode, 1);
    assert.equal(report.complete, false);
    assert.equal(report.tails[0].errorCode, code);
  }
});

test('成功したCronの予定時刻とキャンセル前の処理段階を保存し、任意のログ項目を除く', async () => {
  const scheduledTime = 1791621000000;
  const { report } = await monitor(undefined, false, [
    { outcome: 'ok', event: { cron: '0 * * * *', scheduledTime } },
    {
      outcome: 'canceled',
      event: { cron: '0 19 * * *', scheduledTime },
      logs: [
        ...['start', 'end'].map((phase) => ({
          message: [
            JSON.stringify({
              event: 'maintenance_task',
              task: 'federationMetadata',
              phase,
              at: scheduledTime,
              secret: 'sensitive-fixture-do-not-save',
            }),
          ],
        })),
        {
          message: [
            JSON.stringify({
              event: 'maintenance_task',
              task: 'results',
              phase: 'start',
              at: scheduledTime,
            }),
          ],
        },
        {
          message: [
            JSON.stringify({
              event: 'maintenance_task',
              task: 'sensitive-fixture-do-not-save',
              phase: 'start',
              at: scheduledTime,
            }),
          ],
        },
      ],
    },
  ]);
  assert.equal(
    report.events.find((event) => event.kind === 'scheduled').scheduledTime,
    scheduledTime,
  );
  assert.equal(
    report.events.find(
      (event) => event.kind === 'scheduled' && event.outcome === 'canceled',
    ).outcome,
    'canceled',
  );
  assert.deepEqual(
    report.maintenance.map(({ task, phase }) => ({ task, phase })),
    [
      { task: 'federationMetadata', phase: 'start' },
      { task: 'federationMetadata', phase: 'end' },
      { task: 'results', phase: 'start' },
    ],
  );
});

test('署名付き通信を相手と分ごとに集計し、不正なoriginを記録しない', async () => {
  const peerOrigin = 'https://quiz-relay-federation-b-test.quiz-relay.workers.dev';
  const items = [0, 1000, 60000].map((offset) => ({
    outcome: 'ok',
    logs: [
      {
        message: [
          JSON.stringify({
            event: 'federation_request',
            peerOrigin,
            at: 1800000000000 + offset,
          }),
        ],
      },
    ],
  }));
  items.push({
    outcome: 'ok',
    logs: [
      {
        message: [
          JSON.stringify({
            event: 'federation_request',
            peerOrigin: 'https://invalid.example/private',
            at: 1800000000000,
          }),
        ],
      },
    ],
  });
  const { report } = await monitor(undefined, false, items);
  assert.deepEqual(
    report.peerTraffic.map((row) => row.requests),
    [2, 1],
  );
  assert(report.peerTraffic.every((row) => row.peerOrigin === peerOrigin));
});
