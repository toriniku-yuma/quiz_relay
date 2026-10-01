// Keep legal 2MB imports and growing result originals below SQLite's per-value limit.
type Chunked = { chunks: string[]; storageFormat: 'json-chunks-1' };
const chunked = (value: unknown): value is Chunked =>
  !!value &&
  typeof value === 'object' &&
  'storageFormat' in value &&
  value.storageFormat === 'json-chunks-1';
type Store = Pick<DurableObjectTransaction, 'get' | 'put' | 'delete'>;

export async function readStored<T>(
  storage: DurableObjectStorage,
  key: string,
): Promise<T | undefined> {
  const value = await storage.get<T | Chunked>(key);
  if (!chunked(value)) return value;
  // Header and chunks must come from one snapshot even while a save replaces them.
  return storage.transaction(async (tx) => {
    const latest = await tx.get<T | Chunked>(key);
    if (!chunked(latest)) return latest;
    const chunks = await tx.get<string>(latest.chunks);
    return JSON.parse(
      latest.chunks
        .map((part) => {
          const text = chunks.get(part);
          if (text === undefined) throw new Error('STORAGE_INCOMPLETE');
          return text;
        })
        .join(''),
    ) as T;
  });
}
export async function writeStored(tx: Store, key: string, value: unknown) {
  const previous = await tx.get<unknown>(key);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length <= 512 * 1024) {
    await tx.put(key, value);
  } else {
    const generation = crypto.randomUUID();
    const chunks: string[] = [];
    // 64K UTF-16 units remain well below 2MB in both serialized and UTF-8 form.
    for (let start = 0; start < json.length; start += 65536) {
      const part = `value:${key}:${generation}:${chunks.length}`;
      chunks.push(part);
      await tx.put(part, json.slice(start, start + 65536));
    }
    await tx.put(key, { chunks, storageFormat: 'json-chunks-1' } satisfies Chunked);
  }
  if (chunked(previous)) await tx.delete(previous.chunks);
}
export async function deleteStored(tx: Store, key: string) {
  const previous = await tx.get<unknown>(key);
  await tx.delete(key);
  if (chunked(previous)) await tx.delete(previous.chunks);
}
