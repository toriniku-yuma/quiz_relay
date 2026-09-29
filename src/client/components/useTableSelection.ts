import { useState } from 'react';
export function useTableSelection<T extends { id: string }>(scope: string) {
  const [state, setState] = useState<{ scope: string; rows: T[] }>({ scope, rows: [] });
  if (state.scope !== scope) setState({ scope, rows: [] });
  const rows = state.scope === scope ? state.rows : [];
  const select = (items: T[], checked: boolean) =>
    setState({
      scope,
      rows: checked
        ? [...rows.filter((r) => !items.some((i) => i.id === r.id)), ...items]
        : rows.filter((r) => !items.some((i) => i.id === r.id)),
    });
  return { rows, select, clear: () => setState({ scope, rows: [] }) };
}
