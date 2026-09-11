export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'stopped';

export function connectGameSocket(
  url: URL,
  callbacks: {
    opened: (socket: WebSocket) => void;
    message: (data: string) => boolean;
    status: (status: ConnectionStatus) => void;
    error: (message: string) => void;
  },
) {
  let disposed = false;
  let failures = 0;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout>;
  let timeout: ReturnType<typeof setTimeout>;
  let sync: ReturnType<typeof setInterval>;

  function connect() {
    callbacks.status('connecting');
    const ws = new WebSocket(url);
    socket = ws;
    timeout = setTimeout(() => ws.close(), 10000);

    ws.onopen = () => {
      if (disposed) return;
      callbacks.opened(ws);
      ws.send('sync');
      sync = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('sync');
      }, 5000);
    };

    ws.onmessage = ({ data }) => {
      if (disposed) return;
      if (callbacks.message(String(data))) {
        // 接続が開いただけでは成功扱いにせず、サーバー状態の受信を確認する。
        clearTimeout(timeout);
        failures = 0;
        callbacks.status('open');
      }
    };

    ws.onclose = ({ code }) => {
      clearTimeout(timeout);
      clearInterval(sync);
      if (disposed) return;

      failures++;
      if (code === 1008 || failures >= 5) {
        callbacks.status('stopped');
        callbacks.error(
          code === 1008
            ? '接続が拒否されました。他のタブを閉じ、再接続してください。'
            : '接続に5回続けて失敗したため、自動再接続を停止しました。通信状態と他のタブを確認し、再接続してください。',
        );
        return;
      }

      callbacks.status('closed');
      retry = setTimeout(connect, 1500);
    };
    ws.onerror = () => ws.close();
  }

  connect();

  return () => {
    disposed = true;
    clearTimeout(retry);
    clearTimeout(timeout);
    clearInterval(sync);
    socket?.close();
  };
}
