import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type InventoryEnv, reconcileRoomInventory } from '../src/erasure/inventory';
import { changeD1, connectD1 } from '../src/worker/db/d1';
import { instances, roomInventoryScans } from '../src/worker/db/schema';
import type { Env } from '../src/worker/env';
import { addInstance, setupOrganization } from '../src/worker/organization/database';

const runtime = env as unknown as {
    GAME_D1: D1Database;
    D1_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  },
  db = connectD1(runtime.GAME_D1);
beforeAll(async () => {
  await applyD1Migrations(runtime.GAME_D1, runtime.D1_MIGRATIONS);
  await setupOrganization(db, { INITIAL_ADMIN_SUBJECT: 'admin' } as Env, 'admin', {
    name: '棚卸し検証',
    instanceName: '初期',
  });
});
afterEach(() => vi.unstubAllGlobals());
async function target() {
  const id = crypto.randomUUID();
  await addInstance(db, 'admin', { id, name: `対象${id.slice(0, 8)}` });
  await changeD1(db, async (writes) => {
    writes.push(
      db
        .update(instances)
        .set({ roomInventoryComplete: false })
        .where(eq(instances.id, id)),
    );
  });
  return (await db.select().from(instances).where(eq(instances.id, id)))[0];
}
it('1001部屋を25件ずつ照合し、重複とDO失敗では完了しない', async () => {
  const scope = await target(),
    register = vi.fn(),
    fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const ids = Array.from({ length: 1001 }, (_, index) =>
    index.toString(16).padStart(64, '0'),
  );
  const environment = {
    LOCAL_ROOM_INVENTORY: JSON.stringify(ids),
    GAME_ROOM: {
      idFromString: (id: string) => id,
      get: (id: string) => ({
        inventoryScope: async () => ({ owner: scope.owner, instanceId: null }),
        registerInventory: async (value: unknown) => register(id, value),
      }),
    },
  } as unknown as InventoryEnv;
  environment.LOCAL_ROOM_INVENTORY = JSON.stringify([ids[0], ids[0]]);
  await expect(reconcileRoomInventory(db, environment)).rejects.toThrow(
    'INVALID_LOCAL_INVENTORY',
  );
  environment.LOCAL_ROOM_INVENTORY = JSON.stringify(ids);
  register.mockRejectedValueOnce(new Error('ROOM_UNAVAILABLE'));
  await expect(reconcileRoomInventory(db, environment)).rejects.toThrow(
    'ROOM_UNAVAILABLE',
  );
  expect(
    (await db.select().from(instances).where(eq(instances.id, scope.id)))[0]
      .roomInventoryComplete,
  ).toBe(false);
  register.mockClear();
  for (let index = 0; index < 40; index++) {
    expect(await reconcileRoomInventory(db, environment)).toBe(false);
    expect(register).toHaveBeenCalledTimes((index + 1) * 25);
  }
  expect(await reconcileRoomInventory(db, environment)).toBe(true);
  expect(new Set(register.mock.calls.map(([id]) => id)).size).toBe(1001);
  expect(
    (await db.select().from(instances).where(eq(instances.id, scope.id)))[0]
      .roomInventoryComplete,
  ).toBe(true);
  expect(await db.select().from(roomInventoryScans)).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});
it('クラウド途中ページの失敗後は保存済みcursorから再開する', async () => {
  const scope = await target(),
    register = vi.fn();
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
  const environment = {
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
  expect(await reconcileRoomInventory(db, environment)).toBe(false);
  await expect(reconcileRoomInventory(db, environment)).rejects.toThrow(
    'INVENTORY_UNAVAILABLE',
  );
  expect(
    (await db.select().from(instances).where(eq(instances.id, scope.id)))[0]
      .roomInventoryComplete,
  ).toBe(false);
  expect(await reconcileRoomInventory(db, environment)).toBe(true);
  expect(register.mock.calls.map(([id]) => id)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
  for (const call of fetcher.mock.calls.slice(1))
    expect(new URL(call[0]).searchParams.get('cursor')).toBe('next-page');
});
