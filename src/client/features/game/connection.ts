export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'stopped';

export function connectGameSocket(
  url: URL,
  callbacks: {
    sync: () => string;
    opened: (socket: WebSocket) => void;
    message: (data: string) => boolean;
    status: (status: ConnectionStatus) => void;
    error: (message: string) => void;
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

  function disconnected(ws: WebSocket, code = 1006) {
    if (disposed || socket !== ws) return;
    // closeイベントが届かない通信断でも、古い接続を切り離して再試行する。
    socket = undefined;
    clearTimeout(timeout);
    clearInterval(sync);
    ws.close();

    if (code === 1008) {
      stop('接続が拒否されました。他のタブを閉じ、再接続してください。');
      return;
    }
    if (retryWindow === undefined) {
      retryWindow = setTimeout(() => {
        stop(
          '30秒間接続を復旧できなかったため、自動再接続を停止しました。通信状態を確認し、再接続してください。',
        );
      }, 30000);
    }

    callbacks.status('closed');
    retry = setTimeout(connect, 1500);
  }

  function connect() {
    if (disposed) return;
    callbacks.status('connecting');
    const ws = new WebSocket(url);
    socket = ws;
    timeout = setTimeout(() => disconnected(ws), 10000);

    ws.onopen = () => {
      if (disposed || socket !== ws) return;
      callbacks.opened(ws);
      ws.send(callbacks.sync());
      sync = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(callbacks.sync());
      }, 5000);
    };

    ws.onmessage = ({ data }) => {
      if (disposed || socket !== ws) return;
      if (callbacks.message(String(data))) {
        // ACKではなく、有効な状態の受信をもって接続復旧とする。
        clearTimeout(timeout);
        timeout = setTimeout(() => disconnected(ws), 15000);
        clearTimeout(retryWindow);
        retryWindow = undefined;
        callbacks.status('open');
      }
    };

    ws.onclose = ({ code }) => disconnected(ws, code);
    ws.onerror = () => disconnected(ws);
  }

  connect();
  return dispose;
}
