import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const minutes = Number(process.argv[2] ?? 40);
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 45)
  throw new Error('DURATION_INVALID');
await mkdir('.wrangler/qa', { recursive: true });
const startedAt = new Date().toISOString();
const events = [],
  lifecycle = [],
  maintenance = [],
  counts = new Map(),
  children = [],
  tails = [];
const targets = ['a-test', 'b-test', 'a-erasure-test', 'b-erasure-test'];
const maintenanceTasks = [
  'federationNonces',
  'federationSessions',
  'sharedQuestionRetention',
  'federationResult',
  'federationQuestions',
  'federationControl',
  'federationControlApply',
  'federationMetadata',
  'authentication',
  'inventory',
  'instance',
  'results',
  'anonymization',
  'retention',
  'reviews',
  'difficulty',
];
const wrangler = createRequire(import.meta.url).resolve('wrangler');
let closed = 0,
  stopping = false;

function failTail(tail, code) {
  tail.errorCode ??= code;
  process.exitCode = 1;
  console.log(JSON.stringify({ event: 'tail_failed', target: tail.target, code }));
}

function collect(target, item) {
  if (!item.outcome) return;
  const version = /^[a-f0-9-]{36}$/.test(item.scriptVersion?.id)
    ? item.scriptVersion.id
    : undefined;
  for (const log of item.logs ?? [])
    for (const value of log.message ?? [])
      try {
        const parsed = JSON.parse(value);
        if (
          parsed.event === 'maintenance_task' &&
          maintenanceTasks.includes(parsed.task) &&
          ['start', 'end'].includes(parsed.phase) &&
          Number.isSafeInteger(parsed.at)
        ) {
          const entry = {
            event: 'runtime_maintenance',
            at: new Date(parsed.at).toISOString(),
            receivedAt: new Date().toISOString(),
            target,
            version,
            task: parsed.task,
            phase: parsed.phase,
          };
          if (maintenance.length < 1000) maintenance.push(entry);
          console.log(JSON.stringify(entry));
          continue;
        }
        if (
          ![
            'game_room_initialized',
            'room_lobby_connected',
            'room_lobby_closed',
          ].includes(parsed.event) ||
          !/^[a-f0-9]{64}$/.test(parsed.objectId)
        )
          continue;
        const entry = {
          event: 'runtime_lifecycle',
          at: new Date(item.eventTimestamp ?? Date.now()).toISOString(),
          receivedAt: new Date().toISOString(),
          target,
          version,
          action: parsed.event,
          objectId: parsed.objectId,
          roomId: /^[a-f0-9-]{36}$/.test(parsed.roomId) ? parsed.roomId : undefined,
          sockets: Number.isSafeInteger(parsed.sockets) ? parsed.sockets : undefined,
          heartbeatAgeMs: Number.isSafeInteger(parsed.heartbeatAgeMs)
            ? parsed.heartbeatAgeMs
            : undefined,
          code: /^[A-Z_0-9]{3,80}$/.test(parsed.code) ? parsed.code : undefined,
        };
        if (lifecycle.length < 1000) lifecycle.push(entry);
        console.log(JSON.stringify(entry));
      } catch {}
  const url = item.event?.request?.url ? new URL(item.event.request.url) : null;
  const path = url?.pathname ?? null;
  const socketKind = url?.searchParams.get('kind');
  const status = item.event?.response?.status ?? null;
  const kind = item.event?.cron
    ? 'scheduled'
    : item.event?.rpcMethod === 'runMaintenance'
      ? 'maintenance'
      : path
        ? 'http'
        : 'other';
  const key = JSON.stringify({ target, version, kind, outcome: item.outcome });
  const count = counts.get(key) ?? {
    target,
    version,
    kind,
    outcome: item.outcome,
    count: 0,
    maxCpuMs: 0,
  };
  count.count++;
  count.maxCpuMs = Math.max(count.maxCpuMs, item.cpuTime ?? 0);
  counts.set(key, count);
  const tasks = new Set();
  const codes = (item.logs ?? []).flatMap((log) =>
    (log.message ?? []).flatMap((value) => {
      try {
        const parsed = JSON.parse(value);
        const failure =
          [
            'request_failed',
            'load_failed',
            'maintenance_task_failed',
            'maintenance_failed',
            'room_lobby_failed',
            'federation_result_dispatch_failed',
          ].includes(parsed.event) && /^[A-Z_0-9]{3,80}$/.test(parsed.code);
        if (failure && maintenanceTasks.includes(parsed.task)) tasks.add(parsed.task);
        return failure ? [parsed.code] : [];
      } catch {
        return [];
      }
    }),
  );
  const errors = (item.exceptions ?? []).map((error) =>
    /Durable Object.*(?:no longer active|replaced)/i.test(error.message ?? '')
      ? 'OBJECT_REPLACED'
      : /blockConcurrencyWhile|30 seconds|timed out/i.test(error.message ?? '')
        ? 'CONCURRENCY_TIMEOUT'
        : /reset|broken/i.test(error.message ?? '')
          ? 'OBJECT_RESET'
          : /exceeded.*cpu/i.test(error.message ?? '')
            ? 'CPU_LIMIT'
            : /too many subrequests/i.test(error.message ?? '')
              ? 'SUBREQUEST_LIMIT'
              : /D1_BUSY|STALE_D1_SNAPSHOT/.test(error.message ?? '')
                ? 'D1_BUSY'
                : /STORAGE_INCOMPLETE/.test(error.message ?? '')
                  ? 'STORAGE_INCOMPLETE'
                  : /^[A-Za-z_]{1,80}$/.test(error.name ?? '')
                    ? error.name
                    : 'EXCEPTION',
  );
  if (
    (status === null || status < 400) &&
    !codes.length &&
    !errors.length &&
    item.outcome === 'ok' &&
    kind !== 'scheduled'
  )
    return;
  const event = {
    event: 'runtime_diagnostic',
    target,
    version,
    at: new Date(item.eventTimestamp ?? Date.now()).toISOString(),
    receivedAt: new Date().toISOString(),
    kind,
    scheduledTime: Number.isSafeInteger(item.event?.scheduledTime)
      ? item.event.scheduledTime
      : undefined,
    outcome: item.outcome,
    path,
    socketKind:
      path === '/api/probes/game/load/socket' && ['lobby', 'game'].includes(socketKind)
        ? socketKind
        : undefined,
    status,
    cpuMs: item.cpuTime ?? null,
    wallMs: item.wallTime ?? null,
    codes,
    tasks: [...tasks],
    errors,
  };
  if (events.length < 1000) events.push(event);
  console.log(JSON.stringify(event));
}

for (const suffix of targets) {
  const target = `quiz-relay-federation-${suffix}`;
  const tail = {
    target,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    errorCode: null,
  };
  tails.push(tail);
  const child = spawn(
    process.execPath,
    ['--no-warnings', wrangler, 'tail', target, '--format', 'json'],
    { windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const start = buffer.indexOf('{');
      if (start < 0) {
        buffer = '';
        break;
      }
      let depth = 0,
        quoted = false,
        escaped = false,
        end = start;
      for (; end < buffer.length; end++) {
        const character = buffer[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{') depth++;
        else if (character === '}' && --depth === 0) {
          end++;
          break;
        }
      }
      if (depth) {
        buffer = buffer.slice(start);
        break;
      }
      try {
        collect(target, JSON.parse(buffer.slice(start, end)));
      } catch {}
      buffer = buffer.slice(end);
    }
    if (buffer.length > 1000000) {
      buffer = '';
      failTail(tail, 'TAIL_BUFFER_LIMIT');
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', () => failTail(tail, 'TAIL_START_FAILED'));
  child.on('close', async (code, signal) => {
    tail.finishedAt = new Date().toISOString();
    tail.exitCode = code;
    tail.signal = signal;
    if (!stopping) failTail(tail, 'TAIL_UNEXPECTED_EXIT');
    console.log(JSON.stringify({ event: 'tail_closed', target, code }));
    if (++closed !== targets.length) return;
    clearTimeout(timer);
    clearInterval(progress);
    const output = {
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: [...counts.values()],
      tails,
      complete: tails.every((tail) => !tail.errorCode),
      events,
      lifecycle,
      maintenance,
    };
    const path = `.wrangler/qa/federation-runtime-${startedAt.replaceAll(/[:.]/g, '-')}.json`;
    await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
    console.log(
      JSON.stringify({
        event: 'runtime_finished',
        path,
        startedAt,
        finishedAt: output.finishedAt,
        counts: output.counts,
        tails,
        complete: output.complete,
        anomalies: events.length,
        lifecycle: lifecycle.length,
      }),
    );
  });
}
const stop = () => {
  stopping = true;
  for (const child of children) child.kill();
};
const timer = setTimeout(stop, minutes * 60000);
const progress = setInterval(
  () =>
    console.log(
      JSON.stringify({
        event: 'runtime_progress',
        at: new Date().toISOString(),
        counts: [...counts.values()],
        tails,
        anomalies: events.length,
      }),
    ),
  60000,
);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(JSON.stringify({ event: 'runtime_started', startedAt, minutes, targets }));
