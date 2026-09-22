import { expect, it } from 'vitest';
import { creationRequest } from '../src/client/features/organization/creationRequest';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
it.each(['', ' '.repeat(4), 'x'.repeat(81), '\u202etest'])(
  '無効な名前を再送要求として固定しない: %s',
  (name) => {
    const saved = storage();
    expect(() => creationRequest(saved, 'key', name)).toThrow();
    expect(saved.getItem('key')).toBeNull();
    expect(creationRequest(saved, 'key', 'Valid').name).toBe('Valid');
  },
);
it('再読込と空白修正後も同じIDを再送し、未確認の別名追加は拒否する', () => {
  const saved = storage();
  const first = creationRequest(saved, 'key', ' Original ');
  expect(creationRequest(saved, 'key', 'Original')).toEqual(first);
  expect(() => creationRequest(saved, 'key', 'Other')).toThrow();
  expect(JSON.parse(saved.getItem('key') ?? '')).toEqual(first);
});
it('旧実装で保存された無効名から修正して再試行できる', () => {
  const saved = storage();
  saved.setItem('key', JSON.stringify({ id: crypto.randomUUID(), name: ' ' }));
  expect(creationRequest(saved, 'key', 'Valid').name).toBe('Valid');
});
