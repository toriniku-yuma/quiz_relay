import { validConnectionReport } from '../../shared/connection-report.ts';

// Only an authenticated, live socket may report, once per connection (also after hibernation).
export function logConnectionReport(
  socket: WebSocket,
  message: string | ArrayBuffer,
  objectId: string,
) {
  if (typeof message !== 'string' || message.length > 1024 || !message.startsWith('{'))
    return false;
  let report: unknown;
  try {
    report = JSON.parse(message);
  } catch {
    return false;
  }
  if (
    !report ||
    typeof report !== 'object' ||
    !('type' in report) ||
    report.type !== 'connection_report'
  )
    return false;
  const attachment = socket.deserializeAttachment();
  if (!attachment.live || attachment.reportReceived) return true;
  attachment.reportReceived = true;
  const accepted = validConnectionReport(report) ? report : undefined;
  if (accepted) attachment.clientReport = accepted;
  socket.serializeAttachment(attachment);
  if (!accepted) return true;
  console.info(
    JSON.stringify({
      event: 'socket_client_report',
      at: Date.now(),
      source: 'client',
      objectId,
      roomId: attachment.roomId,
      connectionId: attachment.connectionId,
      connectMs: accepted.connectMs,
      recovery: accepted.recovery,
    }),
  );
  return true;
}
