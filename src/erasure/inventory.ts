import { eq, sql } from 'drizzle-orm';
import { contentHash } from '../worker/catalog/hash.ts';
import { changeD1, type Database, readD1 } from '../worker/db/d1.ts';
import { instanceDeletions, instances, roomInventoryScans } from '../worker/db/schema.ts';
import type { Env } from '../worker/env.ts';
export type InventoryEnv = {
  GAME_ROOM: Env['GAME_ROOM'];
  CLOUDFLARE_ACCOUNT_ID?: string;
  GAME_ROOM_NAMESPACE_ID?: string;
  DURABLE_OBJECTS_READ_TOKEN?: string;
  LOCAL_ROOM_INVENTORY?: string;
};

// A local room list replaces the Cloudflare listing; otherwise all API settings are required.
function inventorySource(env: InventoryEnv) {
  if (env.LOCAL_ROOM_INVENTORY !== undefined) {
    const local: unknown = JSON.parse(env.LOCAL_ROOM_INVENTORY);
    if (
      !Array.isArray(local) ||
      local.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(local).size !== local.length
    )
      throw new Error('INVALID_LOCAL_INVENTORY');
    return { local: local as string[], cloud: null };
  }
  if (
    !env.CLOUDFLARE_ACCOUNT_ID ||
    !env.GAME_ROOM_NAMESPACE_ID ||
    !env.DURABLE_OBJECTS_READ_TOKEN
  )
    throw new Error('INVENTORY_CONFIGURATION_REQUIRED');
  return {
    local: null,
    cloud: {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      namespaceId: env.GAME_ROOM_NAMESPACE_ID,
      token: env.DURABLE_OBJECTS_READ_TOKEN,
    },
  };
}
// Each call checks one bounded page. Network work stays outside the D1 batch.
export async function reconcileRoomInventory(db: Database, env: InventoryEnv) {
  const { local, cloud } = inventorySource(env);
  const key = cloud ? `${cloud.accountId}:${cloud.namespaceId}` : 'local';
  const localHash = local ? await contentHash(local) : null;
  const scan = await changeD1(db, async (writes) => {
    const pending = await db
      .select()
      .from(instances)
      .where(eq(instances.roomInventoryComplete, false));
    const [restored] = await db
      .select()
      .from(instanceDeletions)
      .where(eq(instanceDeletions.inventoryPending, true))
      .limit(1);
    const [saved] = await db
      .select()
      .from(roomInventoryScans)
      .where(eq(roomInventoryScans.id, key));
    if (!saved && !pending.length && !restored) return null;
    if (pending.some((instance) => instance.state === 'published'))
      throw new Error('INVENTORY_REQUIRES_PAUSE');
    if (saved?.localHash === localHash) return saved;
    if (saved)
      writes.push(db.delete(roomInventoryScans).where(eq(roomInventoryScans.id, key)));
    const created: typeof roomInventoryScans.$inferSelect = {
      id: key,
      scopeIds: pending.map((scope) => scope.id),
      localHash,
      cursor: null,
      complete: false,
    };
    writes.push(db.insert(roomInventoryScans).values(created));
    return created;
  });
  if (!scan) return true;
  if (!scan.complete) {
    const snapshot = await readD1(db, async () => ({
      scopes: await db
        .select()
        .from(instances)
        .where(
          sql`${instances.id} in (select value from json_each(${JSON.stringify(scan.scopeIds)}))`,
        ),
      deletions: await db.select().from(instanceDeletions),
    }));
    if (snapshot.scopes.some((scope) => scope.state === 'published'))
      throw new Error('INVENTORY_REQUIRES_PAUSE');
    let page: {
      success: boolean;
      result?: { id?: string }[];
      result_info?: { cursor?: string };
    };
    if (local) {
      const offset = Number(scan.cursor ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('INVALID_LOCAL_INVENTORY_CURSOR');
      const end = offset + 25;
      page = {
        success: true,
        result: local.slice(offset, end).map((id) => ({ id })),
        result_info: { cursor: end < local.length ? String(end) : undefined },
      };
    } else {
      const url = new URL(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloud.accountId)}/workers/durable_objects/namespaces/${encodeURIComponent(cloud.namespaceId)}/objects`,
      );
      url.searchParams.set('limit', '25');
      if (scan.cursor) url.searchParams.set('cursor', scan.cursor);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${cloud.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('INVENTORY_UNAVAILABLE');
      page = await response.json();
    }
    if (!page.success || !Array.isArray(page.result) || page.result.length > 25)
      throw new Error('INVALID_INVENTORY');
    for (const entry of page.result) {
      if (!entry.id || !/^[a-f0-9]{64}$/.test(entry.id))
        throw new Error('INVALID_ROOM_ID');
      const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromString(entry.id));
      const actual = await room.inventoryScope();
      if (!actual) continue;
      const deleted = snapshot.deletions.find(
        (job) => job.owner === actual.owner && job.deletedAt,
      );
      if (deleted?.deletedAt) {
        await room.eraseRestoredInstance({
          id: deleted.instanceId,
          owner: deleted.owner,
          deletedAt: deleted.deletedAt,
        });
        continue;
      }
      const scope = snapshot.scopes.find((instance) => instance.owner === actual.owner);
      if (scope) await room.registerInventory({ id: scope.id, owner: scope.owner });
      else if (actual.instanceId && scan.scopeIds.includes(actual.instanceId))
        throw new Error('INVENTORY_SCOPE_CONFLICT');
    }
    const cursor = page.result_info?.cursor ?? null;
    if (cursor && cursor === scan.cursor) throw new Error('INVENTORY_CURSOR_CONFLICT');
    const saved = await changeD1(db, async (writes) => {
      const [current] = await db
        .select()
        .from(roomInventoryScans)
        .where(eq(roomInventoryScans.id, key));
      if (
        !current ||
        current.localHash !== localHash ||
        current.cursor !== scan.cursor ||
        current.complete
      )
        return false;
      const scopes = await db
        .select()
        .from(instances)
        .where(
          sql`${instances.id} in (select value from json_each(${JSON.stringify(scan.scopeIds)}))`,
        );
      if (scopes.some((scope) => scope.state === 'published'))
        throw new Error('INVENTORY_REQUIRES_PAUSE');
      writes.push(
        db
          .update(roomInventoryScans)
          .set({ cursor, complete: !cursor })
          .where(eq(roomInventoryScans.id, key)),
      );
      return true;
    });
    if (!saved || cursor) return false;
  }
  await changeD1(db, async (writes) => {
    const [current] = await db
      .select()
      .from(roomInventoryScans)
      .where(eq(roomInventoryScans.id, key));
    if (!current?.complete || current.localHash !== localHash) return;
    const scopes = await db
      .select()
      .from(instances)
      .where(
        sql`${instances.id} in (select value from json_each(${JSON.stringify(current.scopeIds)}))`,
      );
    if (scopes.some((scope) => scope.state === 'published'))
      throw new Error('INVENTORY_REQUIRES_PAUSE');
    writes.push(
      db
        .update(instances)
        .set({ roomInventoryComplete: true })
        .where(
          sql`${instances.id} in (select value from json_each(${JSON.stringify(current.scopeIds)}))`,
        ),
    );
  });
  // The scheduler invokes restored deletions separately, with a fresh D1 query budget.
  const [restored] = await db
    .select()
    .from(instanceDeletions)
    .where(eq(instanceDeletions.inventoryPending, true))
    .limit(1);
  if (restored) return false;
  return changeD1(db, async (writes) => {
    const [current] = await db
      .select()
      .from(roomInventoryScans)
      .where(eq(roomInventoryScans.id, key));
    if (!current?.complete || current.localHash !== localHash) return false;
    writes.push(db.delete(roomInventoryScans).where(eq(roomInventoryScans.id, key)));
    return true;
  });
}
