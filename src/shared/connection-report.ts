export type ConnectionFailure = {
  connectionId: string;
  at: number;
  trigger: 'close' | 'error' | 'connect_timeout' | 'receive_timeout';
  closeCode?: number;
  lastStateAgeMs?: number;
  online?: boolean;
  visibility?: 'visible' | 'hidden';
};

export type ConnectionReport = {
  type: 'connection_report';
  connectMs: number;
  recovery?: ConnectionFailure & { attempts: number; elapsedMs: number };
};

export function validConnectionReport(value: unknown): value is ConnectionReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const duration = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (
    report.type !== 'connection_report' ||
    !duration(report.connectMs) ||
    Object.keys(report).some((key) => !['type', 'connectMs', 'recovery'].includes(key))
  )
    return false;
  if (report.recovery === undefined) return true;
  if (
    !report.recovery ||
    typeof report.recovery !== 'object' ||
    Array.isArray(report.recovery)
  )
    return false;
  const recovery = report.recovery as Record<string, unknown>;
  return (
    Object.keys(recovery).every((key) =>
      [
        'connectionId',
        'at',
        'trigger',
        'closeCode',
        'lastStateAgeMs',
        'online',
        'visibility',
        'attempts',
        'elapsedMs',
      ].includes(key),
    ) &&
    typeof recovery.connectionId === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(recovery.connectionId) &&
    duration(recovery.at) &&
    typeof recovery.trigger === 'string' &&
    ['close', 'error', 'connect_timeout', 'receive_timeout'].includes(
      String(recovery.trigger),
    ) &&
    (recovery.closeCode === undefined ||
      (recovery.trigger === 'close' &&
        duration(recovery.closeCode) &&
        Number(recovery.closeCode) >= 1000 &&
        Number(recovery.closeCode) <= 4999)) &&
    (recovery.lastStateAgeMs === undefined || duration(recovery.lastStateAgeMs)) &&
    (recovery.online === undefined || typeof recovery.online === 'boolean') &&
    (recovery.visibility === undefined ||
      (typeof recovery.visibility === 'string' &&
        ['visible', 'hidden'].includes(recovery.visibility))) &&
    duration(recovery.attempts) &&
    Number(recovery.attempts) > 0 &&
    duration(recovery.elapsedMs)
  );
}
