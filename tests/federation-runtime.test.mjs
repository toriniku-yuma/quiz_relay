import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

// Run the unchanged CLI module with local child processes and storage substituted.
const scriptUrl = new URL('../scripts/federation-runtime.mjs', import.meta.url);
const source = await readFile(scriptUrl, 'utf8');
async function monitor(failure, interrupted = false, items = []) {
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
  for (const item of items) children[0].stdout.emit('data', JSON.stringify(item));
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
  return { report: reports[0], exitCode: fakeProcess.exitCode ?? 0 };
}

test('終了時刻に監視を止めた場合は4対象の終了状態を保存して成功する', async () => {
  const { report, exitCode } = await monitor();
  assert.equal(exitCode, 0);
  assert.equal(report.complete, true);
  assert.equal(report.tails.length, 4);
  assert(
    report.tails.every((tail) => tail.startedAt && tail.finishedAt && !tail.errorCode),
  );
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
    { outcome: 'ok', event: { cron: '* * * * *', scheduledTime } },
    {
      outcome: 'canceled',
      event: { rpcMethod: 'runMaintenance' },
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
              task: 'reviews',
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
    report.events.find((event) => event.kind === 'maintenance').outcome,
    'canceled',
  );
  assert.deepEqual(
    report.maintenance.map(({ task, phase }) => ({ task, phase })),
    [
      { task: 'federationMetadata', phase: 'start' },
      { task: 'federationMetadata', phase: 'end' },
      { task: 'reviews', phase: 'start' },
    ],
  );
});
