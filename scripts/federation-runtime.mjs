import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { validConnectionReport } from '../src/shared/connection-report.ts';

const minutes = Number(process.argv[2] ?? 40);
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 45)
  throw new Error('DURATION_INVALID');
await mkdir('.wrangler/qa', { recursive: true });
const startedAt = new Date().toISOString();
const events = [],
  lifecycle = [],
  maintenance = [],
  counts = new Map(),
  peerTraffic = new Map(),
  children = [],
  tails = [];
const targets = ['a-test', 'b-test', 'a-erasure-test', 'b-erasure-test'];
const dropped = { events: 0, lifecycle: 0, maintenance: 0 };
const maintenanceTasks = [
  'federationReservations',
  'federationNonces',
  'federationSessions',
  'sharedQuestionRetention',
  'federationResult',
  'federationQuestions',
  'federationQuestionSource',
  'federationControl',
  'federationControlApply',
  'federationMetadata',
  'authentication',
  'instance',
  'results',
  'anonymization',
  'retention',
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

function retain(stream, entries, entry, limit) {
  if (entries.length < limit) {
    entries.push(entry);
    return;
  }
  process.exitCode = 1;
  if (++dropped[stream] === 1)
    console.log(JSON.stringify({ event: 'runtime_overflow', stream, limit }));
}

function collect(target, item) {
  if (!item.outcome) return;
  let socket;
  const version = /^[a-f0-9-]{36}$/.test(item.scriptVersion?.id)
    ? item.scriptVersion.id
    : undefined;
  for (const log of item.logs ?? [])
    for (const value of log.message ?? [])
      try {
        const parsed = JSON.parse(value);
        if (
          parsed.event === 'load_socket_opened' &&
          /^[a-f0-9-]{36}$/.test(parsed.connectionId) &&
          /^[a-f0-9-]{36}$/.test(parsed.roomId) &&
          ['lobby', 'game'].includes(parsed.socketKind)
        ) {
          socket = {
            connectionId: parsed.connectionId,
            roomId: parsed.roomId,
            socketKind: parsed.socketKind,
          };
          continue;
        }
        if (
          parsed.event === 'federation_request' &&
          typeof parsed.peerOrigin === 'string' &&
          /^https:\/\/[a-z0-9.-]+\.workers\.dev$/.test(parsed.peerOrigin) &&
          Number.isSafeInteger(parsed.at)
        ) {
          const minute = new Date(Math.floor(parsed.at / 60000) * 60000).toISOString();
          const key = JSON.stringify({ target, peerOrigin: parsed.peerOrigin, minute });
          const current = peerTraffic.get(key) ?? {
            target,
            peerOrigin: parsed.peerOrigin,
            minute,
            requests: 0,
          };
          current.requests++;
          peerTraffic.set(key, current);
          continue;
        }
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
            runId: /^[a-f0-9-]{36}$/.test(parsed.runId) ? parsed.runId : undefined,
            taskIndex:
              Number.isSafeInteger(parsed.taskIndex) && parsed.taskIndex >= 0
                ? parsed.taskIndex
                : undefined,
            frequency: ['hourly', 'daily'].includes(parsed.frequency)
              ? parsed.frequency
              : undefined,
            outcome: ['ok', 'pending', 'failed'].includes(parsed.outcome)
              ? parsed.outcome
              : undefined,
          };
          retain('maintenance', maintenance, entry, 1000);
          console.log(JSON.stringify(entry));
          continue;
        }
        if (
          ![
            'game_room_initialized',
            'game_socket_connected',
            'game_socket_disconnected',
            'game_socket_closed',
            'room_lobby_connected',
            'room_lobby_closed',
            'socket_client_report',
          ].includes(parsed.event) ||
          !/^[a-f0-9]{64}$/.test(parsed.objectId)
        )
          continue;
        const entry = {
          event: 'runtime_lifecycle',
          at: new Date(item.eventTimestamp ?? Date.now()).toISOString(),
          loggedAt: Number.isSafeInteger(log.timestamp)
            ? new Date(log.timestamp).toISOString()
            : undefined,
          receivedAt: new Date().toISOString(),
          target,
          version,
          action: parsed.event,
          objectId: parsed.objectId,
          roomId: /^[a-f0-9-]{36}$/.test(parsed.roomId) ? parsed.roomId : undefined,
          connectionId: /^[a-f0-9-]{36}$/.test(parsed.connectionId)
            ? parsed.connectionId
            : undefined,
          closeCode: Number.isInteger(parsed.closeCode) ? parsed.closeCode : undefined,
          wasClean: typeof parsed.wasClean === 'boolean' ? parsed.wasClean : undefined,
          sockets: Number.isSafeInteger(parsed.sockets) ? parsed.sockets : undefined,
          heartbeatAgeMs: Number.isSafeInteger(parsed.heartbeatAgeMs)
            ? parsed.heartbeatAgeMs
            : undefined,
          code: /^[A-Z_0-9]{3,80}$/.test(parsed.code) ? parsed.code : undefined,
          reportReceived:
            typeof parsed.reportReceived === 'boolean'
              ? parsed.reportReceived
              : undefined,
          clientReport: validConnectionReport(parsed.clientReport)
            ? parsed.clientReport
            : undefined,
          ...(parsed.event === 'socket_client_report' &&
          validConnectionReport({
            type: 'connection_report',
            connectMs: parsed.connectMs,
            recovery: parsed.recovery,
          })
            ? { source: 'client', connectMs: parsed.connectMs, recovery: parsed.recovery }
            : {}),
        };
        retain('lifecycle', lifecycle, entry, 10000);
        console.log(JSON.stringify(entry));
      } catch {}
  const url = item.event?.request?.url ? new URL(item.event.request.url) : null;
  const path = url?.pathname ?? null;
  const socketKind = url?.searchParams.get('kind');
  const status = item.event?.response?.status ?? null;
  const kind = item.event?.cron ? 'scheduled' : path ? 'http' : 'other';
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
  const diagnostics = [];
  const codes = (item.logs ?? []).flatMap((log) =>
    (log.message ?? []).flatMap((value) => {
      try {
        const parsed = JSON.parse(value);
        const failure =
          [
            'request_failed',
            'federation_join_failed',
            'federation_peer_failed',
            'load_failed',
            'maintenance_task_failed',
            'maintenance_failed',
            'room_lobby_failed',
            'game_socket_failed',
            'game_disconnect_failed',
            'room_disconnect_failed',
            'federation_result_dispatch_failed',
            'result_save_failed',
            'match_lifecycle_failed',
            'match_finish_notification_failed',
          ].includes(parsed.event) && /^[A-Z_0-9]{3,80}$/.test(parsed.code);
        if (failure && maintenanceTasks.includes(parsed.task)) tasks.add(parsed.task);
        if (failure)
          diagnostics.push({
            event: parsed.event,
            code: parsed.code,
            correlationId: /^[a-f0-9-]{36}$/.test(parsed.correlationId)
              ? parsed.correlationId
              : undefined,
            connectionId: /^[a-f0-9-]{36}$/.test(parsed.connectionId)
              ? parsed.connectionId
              : undefined,
            operationId: /^[a-f0-9-]{36}$/.test(parsed.operationId)
              ? parsed.operationId
              : undefined,
            instanceId: /^[a-f0-9-]{36}$/.test(parsed.instanceId)
              ? parsed.instanceId
              : undefined,
            matchId: /^[a-f0-9-]{36}$/.test(parsed.matchId) ? parsed.matchId : undefined,
            errorType: [
              'Error',
              'TypeError',
              'RangeError',
              'SyntaxError',
              'DOMException',
              'UnknownError',
            ].includes(parsed.errorType)
              ? parsed.errorType
              : undefined,
            locations: Array.isArray(parsed.locations)
              ? parsed.locations
                  .filter(
                    (location) =>
                      typeof location === 'string' &&
                      /^[A-Za-z][A-Za-z0-9_.-]{0,79}\.(?:js|mjs|ts|tsx):\d{1,8}:\d{1,8}$/.test(
                        location,
                      ),
                  )
                  .slice(0, 6)
              : [],
            path: [
              '/federation/v1/participation/authorize',
              '/api/v1/participation/reservations',
              '/federation/v1/metadata',
              '/federation/v1/questions/sync',
            ].includes(parsed.path)
              ? parsed.path
              : undefined,
            peerStatus:
              Number.isInteger(parsed.peerStatus) &&
              parsed.peerStatus >= 100 &&
              parsed.peerStatus <= 599
                ? parsed.peerStatus
                : undefined,
            timeoutMs: [5000, 15000].includes(parsed.timeoutMs)
              ? parsed.timeoutMs
              : undefined,
            elapsedMs:
              Number.isSafeInteger(parsed.elapsedMs) && parsed.elapsedMs >= 0
                ? parsed.elapsedMs
                : undefined,
            objectId: /^[a-f0-9]{64}$/.test(parsed.objectId)
              ? parsed.objectId
              : undefined,
            stage: [
              'route.read',
              'login.read',
              'home.prepare',
              'login.recheck',
              'host.reserve',
              'home.issue',
              'ticket.verify',
              'login.confirm',
              'host.exchange',
              'lobby.disconnect',
              'game.disconnect',
              'gate',
              'close',
              'read',
              'sweep',
              'save',
              'broadcast',
            ].includes(parsed.stage)
              ? parsed.stage
              : undefined,
            markers: Array.isArray(parsed.markers)
              ? parsed.markers.filter((marker) =>
                  [
                    'CONCURRENCY',
                    'TIMEOUT',
                    'RESET',
                    'REPLACED',
                    'CANCELED',
                    'DISCONNECTED',
                    'STORAGE',
                    'OVERLOADED',
                  ].includes(marker),
                )
              : [],
            remote: parsed.remote === true,
            retryable: parsed.retryable === true,
            overloaded: parsed.overloaded === true,
          });
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
    ![
      '/api/v1/participation/login/join',
      '/federation/v1/participation/authorize',
      '/api/v1/participation/reservations',
    ].includes(path) &&
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
    ...(path === '/api/probes/game/load/socket' ? socket : undefined),
    status,
    cpuMs: item.cpuTime ?? null,
    wallMs: item.wallTime ?? null,
    codes,
    diagnostics,
    tasks: [...tasks],
    errors,
  };
  retain('events', events, event, 1000);
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
  let diagnosticBuffer = '';
  const detectReconnect = (chunk) => {
    diagnosticBuffer = (diagnosticBuffer + chunk.toString()).slice(-4096);
    if (!diagnosticBuffer.includes('Tail connection lost. Reconnecting (attempt')) return;
    if (!tail.errorCode) {
      failTail(tail, 'TAIL_CONNECTION_LOST');
      // Wrangler recreates the tail after this warning. A new tail can update DOs;
      // stop it and retain the monitoring gap instead of silently changing the run.
      child.kill();
    }
  };
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
      } catch {
        failTail(tail, 'TAIL_PARSE_FAILED');
      }
      buffer = buffer.slice(end);
    }
    if (buffer.length > 1000000) {
      buffer = '';
      failTail(tail, 'TAIL_BUFFER_LIMIT');
    }
  });
  child.stderr.on('data', detectReconnect);
  child.on('error', () => failTail(tail, 'TAIL_START_FAILED'));
  child.on('close', async (code, signal) => {
    if (buffer.trim()) failTail(tail, 'TAIL_INCOMPLETE_RECORD');
    tail.finishedAt = new Date().toISOString();
    tail.exitCode = code;
    tail.signal = signal;
    if (!stopping && !tail.errorCode) failTail(tail, 'TAIL_UNEXPECTED_EXIT');
    console.log(JSON.stringify({ event: 'tail_closed', target, code }));
    if (++closed !== targets.length) return;
    clearTimeout(timer);
    clearInterval(progress);
    const output = {
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: [...counts.values()],
      tails,
      complete:
        tails.every((tail) => !tail.errorCode) &&
        Object.values(dropped).every((count) => count === 0),
      dropped,
      events,
      lifecycle,
      maintenance,
      peerTraffic: [...peerTraffic.values()],
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
        dropped,
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
        peerTraffic: [...peerTraffic.values()],
        tails,
        anomalies: events.length,
      }),
    ),
  60000,
);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(JSON.stringify({ event: 'runtime_started', startedAt, minutes, targets }));
