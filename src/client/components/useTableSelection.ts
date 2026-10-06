import { useState } from 'react';
export function useTableSelection<T extends { id: string }>(scope: string) {
  const [state, setState] = useState<{ scope: string; rows: T[] }>({ scope, rows: [] });
  if (state.scope !== scope) setState({ scope, rows: [] });
  const rows = state.scope === scope ? state.rows : [];
  const select = (items: T[], checked: boolean) =>
    setState({
      scope,
      rows: checked
        ? [...rows.filter((row) => !items.some((item) => item.id === row.id)), ...items]
        : rows.filter((row) => !items.some((item) => item.id === row.id)),
    });
  return { rows, select, clear: () => setState({ scope, rows: [] }) };
}
