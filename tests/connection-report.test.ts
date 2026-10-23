import { expect, it, vi } from 'vitest';
import {
  type ConnectionReport,
  validConnectionReport,
} from '../src/shared/connection-report';
import { logConnectionReport } from '../src/worker/http/connection-report';

const report = {
  type: 'connection_report',
  connectMs: 20,
  recovery: {
    connectionId: crypto.randomUUID(),
    at: 1700000000000,
    trigger: 'close',
    closeCode: 1006,
    online: false,
    visibility: 'hidden',
    lastStateAgeMs: 10000,
    attempts: 2,
    elapsedMs: 5000,
  },
};

it('診断は固定フィールドだけを受け入れ、未知の本文・不正な型を拒否する', () => {
  expect(validConnectionReport(report)).toBe(true);
  for (const invalid of [
    null,
    [],
    { ...report, token: 'secret' },
    { ...report, connectMs: -1 },
    { ...report, connectMs: Infinity },
    { ...report, recovery: null },
    ...[
      { token: 'secret' },
      { connectionId: 'secret' },
      { trigger: ['close'] },
      { visibility: ['hidden'] },
      { attempts: 0 },
      { at: '1700000000000' },
      { closeCode: 999 },
      { online: 'true' },
      { elapsedMs: NaN },
    ].map((change) => ({ ...report, recovery: { ...report.recovery, ...change } })),
  ])
    expect(validConnectionReport(invalid)).toBe(false);
});

it('同じ接続からの診断は1回だけ保存し、休止復帰後も重複させない', () => {
  let attachment = {
    live: true,
    reportReceived: false,
    clientReport: undefined as ConnectionReport | undefined,
    connectionId: crypto.randomUUID(),
    roomId: 'room',
    actorId: 'secret',
  };
  const socket = {
    deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment: (value: typeof attachment) => {
      attachment = structuredClone(value);
    },
  } as WebSocket;
  const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    expect(logConnectionReport(socket, 'sync', 'object')).toBe(false);
    expect(logConnectionReport(socket, new ArrayBuffer(3), 'object')).toBe(false);
    expect(logConnectionReport(socket, JSON.stringify(report), 'object')).toBe(true);
    expect(logConnectionReport(socket, JSON.stringify(report), 'object')).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({
      event: 'socket_client_report',
      source: 'client',
      connectionId: attachment.connectionId,
      recovery: report.recovery,
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('secret');
    expect(attachment.clientReport).toEqual(report);
    expect(JSON.stringify(attachment).length).toBeLessThan(2048);
    attachment.reportReceived = false;
    attachment.clientReport = undefined;
    attachment.live = false;
    logConnectionReport(socket, JSON.stringify(report), 'object');
    expect(logged).toHaveBeenCalledTimes(1);
    attachment.live = true;
    logConnectionReport(socket, JSON.stringify({ ...report, token: 'secret' }), 'object');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(attachment.reportReceived).toBe(true);
    expect(attachment.clientReport).toBeUndefined();
    expect(logConnectionReport(socket, ' '.repeat(1025), 'object')).toBe(false);
  } finally {
    logged.mockRestore();
  }
});
