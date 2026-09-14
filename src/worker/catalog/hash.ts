import canonicalize from 'canonicalize';

export async function contentHash(value: unknown) {
  const serialized = canonicalize(value);
  if (!serialized) throw new Error('INVALID_DEFINITION');

  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(serialized),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
