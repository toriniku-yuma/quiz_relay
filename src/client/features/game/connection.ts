import type {
  ConnectionFailure,
  ConnectionReport,
} from '../../../shared/connection-report';
import { settings } from '../../../shared/settings';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'stopped';

export function connectGameSocket(
  url: URL,
  callbacks: {
    sync: () => string;
    opened: (socket: WebSocket) => void;
    message: (data: string) => boolean;
    status: (status: ConnectionStatus) => void;
    error: (message: string) => void;
    released?: () => void;
    finished?: () => boolean;
  },
) {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout>;
  let timeout: ReturnType<typeof setTimeout>;
  let sync: ReturnType<typeof setInterval>;
  let retryWindow: ReturnType<typeof setTimeout> | undefined;
  let recoveryStartedAt: number | undefined;
  let failure: ConnectionFailure | undefined;
  let recoveryAttempts = 0;
  let attempt: { id: string; startedAt: number; receivedAt?: number };

  function log(
    event: string,
    details: Record<string, string | number | boolean | undefined> = {},
  ) {
    console.info(
      JSON.stringify({
        event,
        at: new Date().toISOString(),
        connectionId: attempt.id,
        kind: url.pathname.includes('/rooms/') ? 'lobby' : 'game',
        online: typeof navigator === 'undefined' ? undefined : navigator.onLine,
        visibility:
          typeof document === 'undefined' ? undefined : document.visibilityState,
        ...details,
      }),
    );
  }

  function dispose() {
    disposed = true;
    clearTimeout(retry);
    clearTimeout(timeout);
    clearInterval(sync);
    clearTimeout(retryWindow);
    socket?.close();
    socket = undefined;
  }

  function stop(message: string, trigger: 'retry_window' | 'policy') {
    log('client_socket_stopped', { trigger });
    dispose();
    callbacks.status('stopped');
    callbacks.error(message);
  }

  function disconnected(
    ws: WebSocket,
    code = 1006,
    reason = '',
    trigger: ConnectionFailure['trigger'] = 'close',
  ) {
    if (disposed || socket !== ws) return;
    const finished = callbacks.finished?.() === true;
    if (!failure)
      failure = {
        connectionId: attempt.id,
        at: Date.now(),
        trigger,
        closeCode: trigger === 'close' ? code : undefined,
        lastStateAgeMs:
          attempt.receivedAt === undefined
            ? undefined
            : Math.max(0, Date.now() - attempt.receivedAt),
        online: typeof navigator === 'undefined' ? undefined : navigator.onLine,
        visibility:
          typeof document === 'undefined' ? undefined : document.visibilityState,
      };
    log('client_socket_disconnected', {
      trigger,
      closeCode: trigger === 'close' ? code : undefined,
      lastStateAgeMs:
        attempt.receivedAt === undefined ? undefined : Date.now() - attempt.receivedAt,
      finished,
    });
    // closeイベントが届かない通信断でも、古い接続を切り離して再試行する。
    socket = undefined;
    clearTimeout(timeout);
    clearInterval(sync);
    ws.close();

    if (finished) {
      dispose();
      callbacks.status('closed');
      return;
    }

    if (code === 1008) {
      stop(
        reason === 'MATCH_REPLACED'
          ? '新しい参加先へ切り替えました。'
          : reason === 'WAITING_CANCELLED'
            ? '待機を解除しました。'
            : reason === 'INSTANCE_ACCESS_REVOKED'
              ? 'このインスタンスの参加権限がなくなったため、待機を解除しました。'
              : reason === 'NO_RANKED_QUESTIONS'
                ? '出題できる問題がないため待機を解除しました。問題が復旧したら、改めてマッチングしてください。'
                : '接続が拒否されました。他のタブを閉じ、再接続してください。',
        'policy',
      );
      if (
        [
          'NO_RANKED_QUESTIONS',
          'SETUP_UNAVAILABLE',
          'WAITING_EXPIRED',
          'WAITING_CANCELLED',
          'INSTANCE_ACCESS_REVOKED',
          'MATCH_REPLACED',
        ].includes(reason)
      )
        callbacks.released?.();
      return;
    }
    if (retryWindow === undefined) {
      recoveryStartedAt = Date.now();
      retryWindow = setTimeout(() => {
        stop(
          `${settings.connection.retryWindowMs / 1000}秒間接続を復旧できなかったため、自動再接続を停止しました。通信状態を確認し、再接続してください。`,
          'retry_window',
        );
      }, settings.connection.retryWindowMs);
    }

    callbacks.status('closed');
    retry = setTimeout(connect, settings.connection.retryIntervalMs);
  }

  function connect() {
    if (disposed) return;
    callbacks.status('connecting');
    const target = new URL(url);
    attempt = { id: crypto.randomUUID(), startedAt: Date.now() };
    if (failure) recoveryAttempts++;
    target.searchParams.set('connection', attempt.id);
    log('client_socket_connecting');
    const ws = new WebSocket(target);
    socket = ws;
    timeout = setTimeout(
      () => disconnected(ws, 1006, '', 'connect_timeout'),
      settings.connection.connectTimeoutMs,
    );

    ws.onopen = () => {
      if (disposed || socket !== ws) return;
      callbacks.opened(ws);
      ws.send(callbacks.sync());
      sync = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(callbacks.sync());
      }, settings.connection.heartbeatIntervalMs);
    };

    ws.onmessage = ({ data }) => {
      if (disposed || socket !== ws) return;
      if (callbacks.message(String(data))) {
        if (attempt.receivedAt === undefined) {
          log('client_socket_ready', {
            connectMs: Date.now() - attempt.startedAt,
            recoveryMs:
              recoveryStartedAt === undefined
                ? undefined
                : Date.now() - recoveryStartedAt,
          });
          const report: ConnectionReport = {
            type: 'connection_report',
            connectMs: Math.max(0, Date.now() - attempt.startedAt),
            recovery: failure
              ? {
                  ...failure,
                  attempts: recoveryAttempts,
                  elapsedMs: Math.max(0, Date.now() - failure.at),
                }
              : undefined,
          };
          // Diagnostics must never stop state processing or change the game outcome.
          try {
            ws.send(JSON.stringify(report));
          } catch {
            log('client_socket_report_failed');
          }
          failure = undefined;
          recoveryAttempts = 0;
        }
        attempt.receivedAt = Date.now();
        // ACKではなく、有効な状態の受信をもって接続復旧とする。
        clearTimeout(timeout);
        timeout = setTimeout(
          () => disconnected(ws, 1006, '', 'receive_timeout'),
          settings.connection.receiveTimeoutMs,
        );
        clearTimeout(retryWindow);
        retryWindow = undefined;
        recoveryStartedAt = undefined;
        callbacks.status('open');
      }
    };

    ws.onclose = ({ code, reason }) => disconnected(ws, code, reason);
    ws.onerror = () => disconnected(ws, 1006, '', 'error');
  }

  connect();
  return dispose;
}
