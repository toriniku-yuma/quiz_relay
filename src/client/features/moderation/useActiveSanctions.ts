import { useEffect, useState } from 'react';
import { activeSanction, type Sanction } from '../../../shared/moderation';

export function useActiveSanctions(rows: Sanction[]) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const current = Math.max(now, Date.now());
    const next = Math.min(
      ...rows
        .filter((row) => activeSanction(row, current) && row.expiresAt)
        .map((row) => Date.parse(row.expiresAt as string)),
    );
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(next - current, 2147483647),
    );
    return () => clearTimeout(timer);
  }, [rows, now]);
  return rows.filter((row) => activeSanction(row, Math.max(now, Date.now())));
}
