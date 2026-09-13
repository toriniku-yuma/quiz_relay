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
    sync: () => 'sync',
    opened: vi.fn(),
    message: vi.fn((data: string) => data === 'state'),
    status: vi.fn(),
    error: vi.fn(),
  };
  const stop = connectGameSocket(new URL('wss://local.test/api/game/socket'), callbacks);
  return { ...callbacks, stop };
}

it('retries fast failures for thirty seconds, then stops and clears timers', () => {
  const connection = start();
  for (let i = 0; i < 20; i++) {
    FakeSocket.instances[i].close();
    vi.advanceTimersByTime(1500);
  }

  expect(FakeSocket.instances).toHaveLength(20);
  expect(connection.status).toHaveBeenLastCalledWith('stopped');
  expect(connection.error).toHaveBeenCalledWith(expect.stringContaining('30秒'));
  expect(vi.getTimerCount()).toBe(0);
  connection.stop();
});

it('opening without valid state does not extend the retry window', () => {
  const connection = start();
  for (let i = 0; i < 20; i++) {
    FakeSocket.instances[i].open();
    FakeSocket.instances[i].onmessage?.({ data: 'ack' });
    FakeSocket.instances[i].close();
    vi.advanceTimersByTime(1500);
  }

  expect(connection.status).toHaveBeenLastCalledWith('stopped');
  expect(vi.getTimerCount()).toBe(0);
  connection.stop();
});

it('recovers after more than five failures and resets the window for the next disconnect', () => {
  const connection = start();
  for (let i = 0; i < 12; i++) {
    FakeSocket.instances[i].close();
    vi.advanceTimersByTime(1500);
  }
  const current = FakeSocket.instances[12];
  current.open();
  current.onmessage?.({ data: 'state' });
  expect(connection.status).toHaveBeenLastCalledWith('open');
  expect(connection.error).not.toHaveBeenCalled();

  current.close();
  vi.advanceTimersByTime(1500);
  const next = FakeSocket.instances[13];
  next.open();
  next.onmessage?.({ data: 'state' });
  vi.advanceTimersByTime(14000);
  next.onmessage?.({ data: 'state' });
  expect(connection.status).toHaveBeenLastCalledWith('open');
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

it('times out an upgrade or initial state after ten seconds', () => {
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

it('rearms the receive watchdog on state, but not ACK, and reconnects without a close event', () => {
  const connection = start();
  const old = FakeSocket.instances[0];
  old.open();
  old.onmessage?.({ data: 'state' });
  // 通信断ではclose()を呼んでもoncloseが届かない状況を再現。
  old.close = vi.fn();
  vi.advanceTimersByTime(14000);
  old.onmessage?.({ data: 'state' });
  vi.advanceTimersByTime(14000);
  old.onmessage?.({ data: 'ack' });
  expect(connection.status).toHaveBeenLastCalledWith('open');
  vi.advanceTimersByTime(1000);
  expect(old.close).toHaveBeenCalledTimes(1);
  expect(connection.status).toHaveBeenLastCalledWith('closed');
  vi.advanceTimersByTime(1500);
  const next = FakeSocket.instances[1];
  next.open();
  next.onmessage?.({ data: 'state' });

  old.onclose?.({ code: 1008 });
  old.onmessage?.({ data: 'state' });
  expect(connection.status).toHaveBeenLastCalledWith('open');
  expect(connection.error).not.toHaveBeenCalled();
  expect(connection.message).toHaveBeenCalledTimes(4);
  connection.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('retry deadline stops an in-flight upgrade and ignores its later events', () => {
  const connection = start();
  FakeSocket.instances[0].close();
  vi.advanceTimersByTime(1500);
  vi.advanceTimersByTime(28500);
  expect(connection.status).toHaveBeenLastCalledWith('stopped');
  const last = FakeSocket.instances.at(-1);
  expect(last?.readyState).toBe(3);
  last?.onopen?.();
  last?.onmessage?.({ data: 'state' });
  expect(connection.opened).not.toHaveBeenCalled();
  expect(connection.message).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  connection.stop();
});
