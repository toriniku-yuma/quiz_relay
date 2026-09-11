import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectGameSocket } from '../src/client/features/game/connection';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();

  constructor(_url: URL) {
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close(code = 1006) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function start() {
  const callbacks = {
    opened: vi.fn(),
    message: vi.fn((data: string) => data === 'state'),
    status: vi.fn(),
    error: vi.fn(),
  };
  const stop = connectGameSocket(new URL('wss://local.test/api/game/socket'), callbacks);
  return { ...callbacks, stop };
}

it('stops after five consecutive failed upgrades and leaves no retry timers', () => {
  const connection = start();

  for (let i = 0; i < 5; i++) {
    FakeSocket.instances[i].close();
    vi.advanceTimersByTime(1500);
  }

  expect(FakeSocket.instances).toHaveLength(5);
  expect(connection.status).toHaveBeenLastCalledWith('stopped');
  expect(connection.error).toHaveBeenCalledWith(expect.stringContaining('5回'));
  expect(vi.getTimerCount()).toBe(0);
  connection.stop();
});

it('an open socket without state does not reset the failure count', () => {
  const connection = start();

  for (let i = 0; i < 5; i++) {
    FakeSocket.instances[i].open();
    FakeSocket.instances[i].close();
    vi.advanceTimersByTime(1500);
  }

  expect(FakeSocket.instances).toHaveLength(5);
  expect(connection.status).toHaveBeenLastCalledWith('stopped');
  connection.stop();
});

it('state receipt resets failures and reconnect invokes the opened callback again', () => {
  const connection = start();
  for (let i = 0; i < 4; i++) {
    FakeSocket.instances[i].close();
    vi.advanceTimersByTime(1500);
  }
  const current = FakeSocket.instances[4];
  current.open();
  current.onmessage?.({ data: 'state' });
  expect(connection.status).toHaveBeenLastCalledWith('open');

  current.close();
  vi.advanceTimersByTime(1500);
  FakeSocket.instances[5].open();

  expect(FakeSocket.instances).toHaveLength(6);
  expect(connection.opened).toHaveBeenCalledTimes(2);
  expect(connection.error).not.toHaveBeenCalled();
  connection.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('policy rejection stops immediately and cleanup cancels pending retries', () => {
  const connection = start();
  FakeSocket.instances[0].close(1008);
  vi.advanceTimersByTime(30000);
  expect(FakeSocket.instances).toHaveLength(1);
  expect(connection.status).toHaveBeenLastCalledWith('stopped');
  connection.stop();

  const retrying = start();
  FakeSocket.instances[1].close();
  retrying.stop();
  vi.advanceTimersByTime(30000);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('closes an upgrade or initial state that never completes after ten seconds', () => {
  const connection = start();

  vi.advanceTimersByTime(10000);
  expect(FakeSocket.instances[0].readyState).toBe(3);
  vi.advanceTimersByTime(1500);
  FakeSocket.instances[1].open();
  vi.advanceTimersByTime(10000);

  expect(FakeSocket.instances[1].readyState).toBe(3);
  expect(connection.status).toHaveBeenLastCalledWith('closed');
  connection.stop();
});
