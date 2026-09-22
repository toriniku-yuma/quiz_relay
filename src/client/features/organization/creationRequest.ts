import { normalizeOrganizationName } from '../../../shared/organization';

export function creationRequest(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key: string,
  requested: unknown,
) {
  const name = normalizeOrganizationName(requested);
  if (name === undefined) throw new Error('名前を1〜80文字で入力してください。');
  const stored = storage.getItem(key);
  let pending: { id: string; name: string } | undefined;
  if (stored) {
    const value = JSON.parse(stored);
    const previous = normalizeOrganizationName(value.name);
    if (previous === undefined) {
      // This name could never pass server validation; it cannot represent an accepted request.
      storage.removeItem(key);
    } else if (typeof value.id !== 'string') {
      throw new Error('保存された追加要求を確認できません。一覧を確認してください。');
    } else pending = { id: value.id, name: previous };
  }
  pending ??= { id: crypto.randomUUID(), name };
  if (pending.name !== name)
    throw new Error(
      `前回の追加「${pending.name}」の結果が未確認です。同じ名前で再送して確認してください。`,
    );
  storage.setItem(key, JSON.stringify(pending));
  return pending;
}
