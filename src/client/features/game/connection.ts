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

  function dispose() {
    disposed = true;
    clearTimeout(retry);
    clearTimeout(timeout);
    clearInterval(sync);
    clearTimeout(retryWindow);
    socket?.close();
    socket = undefined;
  }

  function stop(message: string) {
    dispose();
    callbacks.status('stopped');
    callbacks.error(message);
  }

  function disconnected(ws: WebSocket, code = 1006, reason = '') {
    if (disposed || socket !== ws) return;
    // closeイベントが届かない通信断でも、古い接続を切り離して再試行する。
    socket = undefined;
    clearTimeout(timeout);
    clearInterval(sync);
    ws.close();

    if (callbacks.finished?.()) {
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
      retryWindow = setTimeout(() => {
        stop(
          `${settings.connection.retryWindowMs / 1000}秒間接続を復旧できなかったため、自動再接続を停止しました。通信状態を確認し、再接続してください。`,
        );
      }, settings.connection.retryWindowMs);
    }

    callbacks.status('closed');
    retry = setTimeout(connect, settings.connection.retryIntervalMs);
  }

  function connect() {
    if (disposed) return;
    callbacks.status('connecting');
    const ws = new WebSocket(url);
    socket = ws;
    timeout = setTimeout(() => disconnected(ws), settings.connection.connectTimeoutMs);

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
        // ACKではなく、有効な状態の受信をもって接続復旧とする。
        clearTimeout(timeout);
        timeout = setTimeout(
          () => disconnected(ws),
          settings.connection.receiveTimeoutMs,
        );
        clearTimeout(retryWindow);
        retryWindow = undefined;
        callbacks.status('open');
      }
    };

    ws.onclose = ({ code, reason }) => disconnected(ws, code, reason);
    ws.onerror = () => disconnected(ws);
  }

  connect();
  return dispose;
}
