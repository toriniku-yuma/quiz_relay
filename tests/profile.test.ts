import { expect, it } from 'vitest';
import { normalizeDisplayName } from '../src/shared/profile';

it('表示名はNFKCと前後空白を正規化し、32書記素まで受け付ける', () => {
  expect(normalizeDisplayName('　ＡＢＣ  ')).toBe('ABC');
  expect(normalizeDisplayName('か\u3099')).toBe('が');
  expect(normalizeDisplayName('👩‍👩‍👧‍👦'.repeat(32))).toBe('👩‍👩‍👧‍👦'.repeat(32));
  expect(normalizeDisplayName('あ'.repeat(33))).toBeUndefined();
  for (const input of [
    '',
    '　 ',
    '\u200b',
    '名前\n',
    '名前\t',
    'a\u202eb',
    '\u2028',
    1,
    null,
  ])
    expect(normalizeDisplayName(input)).toBeUndefined();
});
