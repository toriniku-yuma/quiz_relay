import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, expect, it, vi } from 'vitest';
import { type InventoryEnv, reconcileRoomInventory } from '../src/erasure/inventory';
import {
  instanceDeletions,
  instances,
  type roomInventoryScans,
} from '../src/worker/db/schema';

function inventoryDatabase(scope: { id: string; owner: string; state: string }) {
  let scan: typeof roomInventoryScans.$inferSelect | undefined;
  const complete = vi.fn();
  const tx = {
    select: () => ({
      from: (table: unknown) =>
        table === instanceDeletions
          ? Promise.resolve([])
          : {
              where: async () =>
                table === instances ? [scope] : scan ? [structuredClone(scan)] : [],
            },
    }),
    execute: vi.fn(async (query) => {
      if (new PgDialect().sqlToQuery(query).sql.includes('confirm_room_inventory'))
        complete();
    }),
    insert: () => ({
      values: (value: typeof roomInventoryScans.$inferInsert) => ({
        returning: async () => {
          scan = {
            ...value,
            cursor: null,
            complete: false,
            localHash: value.localHash ?? null,
          };
          return [structuredClone(scan)];
        },
      }),
    }),
    update: () => ({
      set: (value: Partial<typeof roomInventoryScans.$inferSelect>) => ({
        where: async () => {
          Object.assign(scan ?? {}, value);
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        scan = undefined;
      },
    }),
  };
  const db = {
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) => {
      const previous = scan ? structuredClone(scan) : undefined;
      try {
        return await callback(tx);
      } catch (error) {
        scan = previous;
        throw error;
      }
    },
  } as unknown as Parameters<typeof reconcileRoomInventory>[0];
  return { db, complete };
}

afterEach(() => vi.unstubAllGlobals());
it('ローカル一覧の重複・部屋の失敗を完了扱いにせず、複数回の処理で全件照合する', async () => {
  const scope = { id: crypto.randomUUID(), owner: 'local-owner', state: 'preparing' };
  const { db, complete } = inventoryDatabase(scope);
  const register = vi.fn();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const ids = Array.from({ length: 1001 }, (_, index) =>
    index.toString(16).padStart(64, '0'),
  );
  const env = {
    LOCAL_ROOM_INVENTORY: JSON.stringify(ids),
    GAME_ROOM: {
      idFromString: (id: string) => id,
      get: (id: string) => ({
        inventoryScope: async () => ({ owner: scope.owner, instanceId: null }),
        registerInventory: async (value: unknown) => register(id, value),
      }),
    },
  } as unknown as InventoryEnv;
  env.LOCAL_ROOM_INVENTORY = JSON.stringify([ids[0], ids[0]]);
  await expect(reconcileRoomInventory(db, env)).rejects.toThrow(
    'INVALID_LOCAL_INVENTORY',
  );
  env.LOCAL_ROOM_INVENTORY = JSON.stringify(ids);
  register.mockRejectedValueOnce(new Error('ROOM_UNAVAILABLE'));
  await expect(reconcileRoomInventory(db, env)).rejects.toThrow('ROOM_UNAVAILABLE');
  expect(complete).not.toHaveBeenCalled();
  register.mockClear();
  for (let index = 0; index < 10; index++) {
    expect(await reconcileRoomInventory(db, env)).toBe(false);
    expect(register).toHaveBeenCalledTimes((index + 1) * 100);
    expect(complete).not.toHaveBeenCalled();
  }
  expect(await reconcileRoomInventory(db, env)).toBe(true);
  expect(new Set(register.mock.calls.map(([id]) => id)).size).toBe(1001);
  expect(complete).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
});

it('クラウドの途中ページで失敗しても、保存済みcursorから再開する', async () => {
  const scope = { id: crypto.randomUUID(), owner: 'test-owner', state: 'preparing' };
  const { db, complete } = inventoryDatabase(scope);
  const register = vi.fn();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: [{ id: 'a'.repeat(64) }],
        result_info: { cursor: 'next-page' },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({ success: true, result: [{ id: 'b'.repeat(64) }], result_info: {} }),
    );
  vi.stubGlobal('fetch', fetcher);
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    GAME_ROOM_NAMESPACE_ID: 'test-namespace',
    DURABLE_OBJECTS_READ_TOKEN: 'test-token',
    GAME_ROOM: {
      idFromString: (id: string) => id,
      get: (id: string) => ({
        inventoryScope: async () => ({ owner: scope.owner, instanceId: null }),
        registerInventory: async (value: unknown) => register(id, value),
      }),
    },
  } as unknown as InventoryEnv;
  expect(await reconcileRoomInventory(db, env)).toBe(false);
  await expect(reconcileRoomInventory(db, env)).rejects.toThrow('INVENTORY_UNAVAILABLE');
  expect(complete).not.toHaveBeenCalled();
  expect(await reconcileRoomInventory(db, env)).toBe(true);
  expect(register.mock.calls.map(([id]) => id)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  expect(complete).toHaveBeenCalledOnce();
  for (const call of fetcher.mock.calls.slice(1))
    expect(new URL(call[0]).searchParams.get('cursor')).toBe('next-page');
});
