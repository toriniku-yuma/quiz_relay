import values from '../../config/runtime.json';

// 運用値は正の整数。接続確認の送信間隔より監視期限を長くする。
for (const group of Object.values(values))
  for (const value of Object.values(group))
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
      throw new Error('INVALID_RUNTIME_CONFIG');
if (
  values.connection.heartbeatIntervalMs >=
    Math.min(values.connection.heartbeatTimeoutMs, values.connection.receiveTimeoutMs) ||
  values.connection.retryIntervalMs >= values.connection.retryWindowMs ||
  values.lobby.reservationLifetimeMs > values.lobby.waitingLifetimeMs ||
  values.lobby.waitingLifetimeMs > values.lobby.sessionLifetimeMs
)
  throw new Error('INVALID_RUNTIME_CONFIG');
export const settings = values;
