export function normalizeDisplayName(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
    return undefined;
  const name = value.normalize('NFKC').trim();
  const length = [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(name)]
    .length;
  if (!name.replace(/\p{Cf}/gu, '').trim() || length > 32) return undefined;
  return name;
}

export type Profile = { displayName: string | null; revision: number };
