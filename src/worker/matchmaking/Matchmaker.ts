import { DurableObject } from 'cloudflare:workers';
import type { ParticipationTarget } from '../../shared/participation.ts';
import { settings } from '../../shared/settings.ts';
import { loadMatchDefinition } from '../catalog/database.ts';
import type { MatchDefinition } from '../catalog/definition.ts';
import { contentHash } from '../catalog/hash.ts';
import type { Env } from '../env.ts';
import {
  type ForeignEntry,
  foreignEntryStatus,
  logoutForeignEntry,
  releaseForeignEntry,
} from '../federation/slots.ts';
import { anonymizeDefinition } from '../game/privacy.ts';
import { matchRoomName, userRoomName } from '../game/room-names.ts';
import type { Participant } from '../rooms/database.ts';
import { scheduledD1 } from '../scheduled.ts';

export type InstanceScope = { id: string; owner: string; mode?: 'casual' | 'room' };
type Entry = {
  band?: number;
  created: number;
  room: string;
  key: string;
  token: string;
  name: string;
  pending?: MatchDefinition | true;
  revoking?: string;
  scope: InstanceScope;
  generation: string;
  userRoom?: boolean;
  guest: boolean;
  requestHash?: string;
  operationId?: string;
};
type Queue = {
  actors: Record<string, Entry>;
  foreign: Record<string, ForeignEntry[]>;
  foreignIntent: Record<string, string>;
  foreignDepartures: Record<string, Entry>;
  foreignChecked: Record<string, number>;
  withdrawals: Record<string, string>;
  loggingOut: Record<string, boolean>;
  admitting: Record<string, { id: string; expires: number; operationId?: string }>;
};
type Admission =
  | { entry: Entry }
  | {
      ok: false;
      code: string;
      instanceId?: string;
      room?: string;
      mode?: 'ranked' | 'casual' | 'room';
    };
type AdmissionReceipt = {
  hash?: string;
  generation?: string;
  expires: number;
  closed?: boolean;
  cancelling?: Entry;
};

export class Matchmaker extends DurableObject<Env> {
  private logouts = new Map<string, Promise<{ ok: true }>>();
  private maintenance: Promise<void> | null = null;
  // Cron uses a separate named object so maintenance cannot reset active matchmaking.
  async runMaintenance() {
    if (!this.maintenance)
      this.maintenance = scheduledD1(this.env).finally(() => {
        this.maintenance = null;
      });
    return this.maintenance;
  }
  async enter(
    actorId: string,
    name: string,
    resume: boolean,
    scope: InstanceScope,
    guest = false,
    operationId?: string,
  ) {
    const requestHash = operationId
      ? await contentHash({ name, scope, guest })
      : undefined;
    if (!(await this.admissionAllowed(actorId)))
      return { ok: false as const, code: 'RATE_LIMIT' };
    await this.clean(actorId);
    if (!resume) await this.cleanForeign(actorId);
    const admissionId = crypto.randomUUID();
    const initial = await this.ctx.blockConcurrencyWhile<Admission | null>(async () => {
      const queue = await this.read();
      const entry = queue.actors[actorId];
      if (queue.withdrawals[actorId])
        return { ok: false as const, code: 'WITHDRAWAL_PENDING' };
      if (this.logouts.has(actorId) || queue.loggingOut[actorId])
        return { ok: false as const, code: 'LOGOUT_PENDING' };
      if (operationId) {
        const receipt = (await this.admissionReceipts(actorId))?.[operationId];
        if (receipt) {
          if (receipt.closed) return { ok: false, code: 'STALE_REQUEST' };
          if (receipt.hash !== requestHash)
            return { ok: false, code: 'OPERATION_CONFLICT' };
          if (!entry || entry.generation !== receipt.generation)
            return { ok: false, code: 'STALE_REQUEST' };
          return { entry };
        }
      }
      if (entry) {
        await this.write(queue);
        if (entry.scope.id !== scope.id || entry.scope.mode !== scope.mode)
          return {
            ok: false as const,
            code: 'OTHER_INSTANCE_ACTIVE',
            instanceId: entry.scope.id,
            room: entry.room,
            mode: entry.scope.mode ?? 'ranked',
          };
        if (!resume)
          return {
            ok: false as const,
            code: 'ALREADY_JOINED',
            instanceId: entry.scope.id,
            room: entry.room,
            mode: entry.scope.mode ?? 'ranked',
          };
        return { entry };
      }
      if (resume) {
        await this.write(queue);
        return { ok: false as const, code: 'NO_ACTIVE_MATCH' };
      }
      if (this.slotCount(queue, actorId) >= 2)
        return { ok: false, code: 'MATCH_SWITCH_PENDING' };
      if (queue.admitting[actorId]?.expires > Date.now())
        return { ok: false, code: 'ALREADY_JOINED' };
      queue.admitting[actorId] = {
        id: admissionId,
        operationId,
        expires: Date.now() + settings.lobby.reservationLifetimeMs,
      };
      await this.write(queue);
      return null;
    });
    if (initial)
      return 'entry' in initial ? this.reserve(actorId, initial.entry) : initial;

    try {
      let definition: MatchDefinition;
      try {
        definition = await loadMatchDefinition(
          this.env,
          {
            owner: scope.owner,
            profile:
              scope.mode === 'casual'
                ? `${this.env.GAME_CONFIG_PROFILE}-casual`
                : this.env.GAME_CONFIG_PROFILE,
          },
          actorId,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          ['NO_RANKED_QUESTIONS', 'RANKED_NOT_CONFIGURED'].includes(error.message)
        ) {
          await this.stopWaiting(scope, (error as Error & { band?: number }).band);
          return { ok: false as const, code: error.message };
        }
        return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
      }
      if (definition.competition.owner !== scope.owner)
        return { ok: false as const, code: 'INSTANCE_MISMATCH' };
      const key = JSON.stringify([
        scope.id,
        scope.mode ?? 'ranked',
        definition.competition,
      ]);
      if (
        new Set(
          Object.values((await this.read()).actors)
            .filter((entry) => entry.scope.id === scope.id)
            .map((entry) => entry.room),
        ).size >= settings.lobby.maxRooms
      )
        await this.clean(undefined, scope.id);
      const snapshot = await this.read();
      const rooms = [
        ...new Set(
          Object.values(snapshot.actors)
            .filter((item) => item.key === key)
            .map((item) => item.room),
        ),
      ];
      // RPCs never hold the organization's storage lock. Recheck reservations when committing.
      const statuses = new Map(
        await Promise.all(
          rooms.map(async (room) => [room, await this.status(room)] as const),
        ),
      );
      const allocated = await this.ctx.blockConcurrencyWhile<Admission>(async () => {
        const queue = await this.read();
        if (operationId && (await this.admissionReceipts(actorId))?.[operationId]?.closed)
          return { ok: false, code: 'STALE_REQUEST' };
        if (queue.withdrawals[actorId])
          return { ok: false as const, code: 'WITHDRAWAL_PENDING' };
        if (this.logouts.has(actorId) || queue.loggingOut[actorId])
          return { ok: false as const, code: 'LOGOUT_PENDING' };
        if (queue.actors[actorId]) return { ok: false as const, code: 'ALREADY_JOINED' };
        if (
          queue.admitting[actorId]?.id !== admissionId ||
          queue.admitting[actorId].expires <= Date.now()
        )
          return { ok: false as const, code: 'STALE_REQUEST' };
        const same = Object.entries(queue.actors).filter(
          ([actor, item]) => actor !== actorId && item.key === key,
        );
        const available = same.find(([, item]) => {
          const status = statuses.get(item.room);
          const pendingRoom = item.pending && !statuses.has(item.room);
          return (
            (pendingRoom || (status && !status.closed && status.phase === 'WAITING')) &&
            same.filter(
              ([actor, other]) =>
                other.room === item.room &&
                (!status ||
                  status.actors.includes(actor) ||
                  snapshot.actors[actor]?.token !== other.token),
            ).length < definition.playersPerMatch
          );
        })?.[1].room;
        if (
          !available &&
          new Set(
            Object.values(queue.actors)
              .filter((item) => item.scope.id === scope.id)
              .map((item) => item.room),
          ).size >= settings.lobby.maxRooms
        )
          return { ok: false as const, code: 'MATCHMAKING_FULL' };
        const entry: Entry = {
          band: definition.selection?.band,
          created: Date.now(),
          room: available ?? crypto.randomUUID(),
          key,
          name,
          guest,
          token: crypto.randomUUID() + crypto.randomUUID(),
          generation: crypto.randomUUID(),
          pending: true,
          operationId,
          requestHash,
          scope,
        };
        queue.foreignIntent[actorId] = `local:${entry.generation}`;
        if (operationId) {
          const operations = await this.admissionReceipts(actorId);
          for (const [id, receipt] of Object.entries(operations))
            if (receipt.expires <= Date.now() && !receipt.cancelling)
              delete operations[id];
          operations[operationId] = {
            hash: requestHash ?? '',
            generation: entry.generation,
            expires: Date.now() + settings.lobby.sessionLifetimeMs,
          };
          await this.ctx.storage.put(`admissions:${actorId}`, operations);
        }
        await this.ctx.storage.put(`definition:${entry.generation}`, definition);
        const receipts =
          (await this.ctx.storage.get<Record<string, number>>(`sessions:${actorId}`)) ??
          {};
        for (const [room, expires] of Object.entries(receipts))
          if (expires <= Date.now()) delete receipts[room];
        receipts[entry.room] = Date.now() + settings.lobby.sessionLifetimeMs;
        await this.ctx.storage.put(`sessions:${actorId}`, receipts);
        delete queue.admitting[actorId];
        queue.actors[actorId] = entry;
        await this.write(queue);
        return { entry };
      });
      return 'entry' in allocated ? this.reserve(actorId, allocated.entry) : allocated;
    } finally {
      await this.ctx.blockConcurrencyWhile(async () => {
        const queue = await this.read();
        if (queue.admitting[actorId]?.id !== admissionId) return;
        delete queue.admitting[actorId];
        await this.write(queue);
      });
    }
  }

  async matchFinished(matchId: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      for (const [actor, entry] of Object.entries(queue.actors)) {
        if (entry.userRoom || entry.room !== matchId) continue;
        delete queue.actors[actor];
        await this.ctx.storage.delete(`definition:${entry.generation}`);
      }
      await this.write(queue);
    });
  }

  async enterRoom(
    actor: Participant,
    room: string,
    scope: InstanceScope,
    input: { operationId: string; password: string; invite: string },
    creation?: Record<string, unknown>,
  ) {
    const hash = await contentHash({
      room,
      scope,
      input,
      ...(creation ? { creation } : {}),
    });
    await this.clean(actor.id);
    await this.cleanForeign(actor.id);
    if (!(await this.admissionAllowed(actor.id)))
      return { ok: false as const, code: 'RATE_LIMIT' };
    const admission = await this.ctx.blockConcurrencyWhile<Admission>(async () => {
      const queue = await this.read();

      if (queue.withdrawals[actor.id]) return { ok: false, code: 'WITHDRAWAL_PENDING' };
      if (this.logouts.has(actor.id) || queue.loggingOut[actor.id])
        return { ok: false, code: 'LOGOUT_PENDING' };
      const existing = queue.actors[actor.id];
      if (existing) {
        if (
          !existing.userRoom ||
          existing.room !== room ||
          existing.scope.id !== scope.id
        ) {
          return {
            ok: false,
            code: 'OTHER_INSTANCE_ACTIVE',
            instanceId: existing.scope.id,
            room: existing.room,
            mode: existing.scope.mode ?? 'ranked',
          };
        } else {
          if (existing.operationId !== input.operationId)
            return {
              ok: false,
              code: 'ALREADY_JOINED',
              room: existing.room,
              instanceId: existing.scope.id,
              mode: 'room',
            };
          if (existing.pending && existing.requestHash !== hash)
            return { ok: false, code: 'OPERATION_CONFLICT' };
          return { entry: existing };
        }
      }
      if (this.slotCount(queue, actor.id) >= 2)
        return { ok: false, code: 'MATCH_SWITCH_PENDING' };
      if (queue.admitting[actor.id]?.expires > Date.now())
        return { ok: false, code: 'ALREADY_JOINED' };
      const entry: Entry = {
        room,
        key: `room:${room}`,
        created: Date.now(),
        token: crypto.randomUUID() + crypto.randomUUID(),
        name: actor.name,
        generation: crypto.randomUUID(),
        scope,
        userRoom: true,
        guest: actor.guest,
        pending: true,
        requestHash: hash,
        operationId: input.operationId,
      };
      queue.foreignIntent[actor.id] = `local:${entry.generation}`;
      const receipts = await this.admissionReceipts(actor.id);
      const receipt = receipts[input.operationId];
      if (receipt)
        return {
          ok: false,
          code: receipt.hash !== hash ? 'OPERATION_CONFLICT' : 'STALE_REQUEST',
        };
      for (const [id, receipt] of Object.entries(receipts))
        if (receipt.expires <= Date.now() && !receipt.cancelling) delete receipts[id];
      receipts[input.operationId] = {
        hash,
        generation: entry.generation,
        expires: Date.now() + settings.lobby.sessionLifetimeMs,
      };
      await this.ctx.storage.put(`admissions:${actor.id}`, receipts);
      queue.actors[actor.id] = entry;
      await this.write(queue);
      return { entry };
    });
    if (!('entry' in admission)) return admission;
    if (creation) {
      const lobby = this.room(room, true);
      const created = await lobby.createUserRoom(room, scope, actor, creation);
      if (!created.ok) {
        await this.cancel(actor.id, room, false, scope.id);
        return { ok: false as const, code: created.code, status: created.status };
      }
      input = { ...input, invite: await lobby.createdRoomInvite(actor.id) };
    }
    return this.reserve(actor.id, admission.entry, input);
  }

  async resumeRoom(actor: string, room: string, instanceId: string) {
    const entry = (await this.read()).actors[actor];
    if (!entry?.userRoom || entry.room !== room || entry.scope.id !== instanceId)
      return { ok: false as const, code: 'STALE_RESERVATION' };
    return this.reserve(actor, entry);
  }

  private async reserve(
    actor: string,
    entry: Entry,
    credentials?: { password: string; invite: string },
  ) {
    if (entry.revoking) {
      await this.finishRevocation(actor, entry);
      const current = (await this.read()).actors[actor];
      if (!current || current.generation !== entry.generation)
        return { ok: false as const, code: 'STALE_REQUEST' };
      entry = current;
    }
    const definition =
      entry.pending === true
        ? await this.ctx.storage.get<MatchDefinition>(`definition:${entry.generation}`)
        : entry.pending;
    const result = await (entry.userRoom
      ? this.room(entry.room, true).joinUserRoom(
          { id: actor, name: entry.name, guest: entry.guest },
          entry.token,
          entry.generation,
          credentials?.password ?? '',
          credentials?.invite ?? '',
          entry.scope,
        )
      : this.room(entry.room).reserve(
          entry.room,
          actor,
          entry.name,
          entry.token,
          definition,
          entry.scope,
          entry.generation,
          entry.guest,
        )
    ).catch(() => null);
    if (!result) return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
    if (!result.ok && entry.userRoom)
      await this.room(entry.room, true).cancelReservation(
        actor,
        false,
        entry.generation,
        entry.token,
      );
    const admitted = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actor];
      if (
        !current ||
        current.generation !== entry.generation ||
        current.token !== entry.token
      )
        return { ok: false as const, code: 'STALE_REQUEST' };
      // A rejected token does not prove the actor has left an active match.
      if (result.ok || !entry.userRoom) {
        delete current.pending;
        await this.ctx.storage.delete(`definition:${entry.generation}`);
      }
      if (result.ok && entry.userRoom) {
        const receipts =
          (await this.ctx.storage.get<Record<string, number>>(`sessions:${actor}`)) ?? {};
        receipts[`room:${entry.room}`] = result.expires;
        await this.ctx.storage.put(`sessions:${actor}`, receipts);
      }
      if (!result.ok && entry.userRoom) delete queue.actors[actor];
      if (!result.ok && queue.foreignIntent[actor] === `local:${entry.generation}`) {
        const previous = queue.foreign[actor]?.find((item) => item.state === 'active');
        if (previous) queue.foreignIntent[actor] = previous.operationId;
      }
      await this.write(queue);
      return result.ok
        ? {
            ok: true as const,
            room: entry.room,
            operationId: entry.operationId,
            token: entry.token,
            expires: result.expires,
          }
        : result;
    });
    if (admitted.ok) {
      await this.ctx.blockConcurrencyWhile(async () => {
        const queue = await this.read();
        if (queue.actors[actor] && queue.actors[actor].generation === entry.generation) {
          for (const previous of queue.foreign[actor] ?? [])
            if (
              previous.state !== 'releasing' &&
              queue.foreignIntent[actor] === `local:${entry.generation}`
            ) {
              previous.state = 'releasing';
              previous.successor = entry.generation;
            }
          await this.write(queue);
        }
      });
      await this.finishForeignReleases(actor);
    }
    return admitted;
  }

  async cancel(
    actorId: string,
    expectedRoom: string,
    revoke = false,
    instanceId?: string,
    forfeit = false,
  ) {
    const initial = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const entry = queue.actors[actorId];
      if (entry && (entry.room !== expectedRoom || entry.scope.id !== instanceId))
        return { ok: false as const, code: 'STALE_ROOM' };
      if (revoke && !forfeit && entry && !entry.revoking) {
        entry.revoking = entry.token;
        entry.token = crypto.randomUUID() + crypto.randomUUID();
      }
      delete queue.admitting[actorId];
      await this.write(queue);
      return { entry };
    });
    if (!('entry' in initial)) return initial;
    const entry = initial.entry;
    if (!entry) {
      if (revoke) await this.room(expectedRoom).cancelReservation(actorId, true);
      return { ok: true as const };
    }
    if (revoke && !forfeit) {
      await this.finishRevocation(actorId, entry);
      return { ok: true as const };
    }
    const accepted = await this.room(entry.room, entry.userRoom).cancelReservation(
      actorId,
      revoke || forfeit,
      entry.generation,
      entry.token,
      forfeit,
    );
    if (!accepted) return { ok: false as const, code: 'MATCH_STARTED' };
    return this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actorId];
      if (current && current.generation === entry.generation) {
        delete queue.actors[actorId];
        await this.ctx.storage.delete(`definition:${entry.generation}`);
      }
      if (queue.foreignIntent[actorId] === `local:${entry.generation}`) {
        const previous = queue.foreign[actorId]?.find((item) => item.state === 'active');
        if (previous) queue.foreignIntent[actorId] = previous.operationId;
      }
      await this.write(queue);
      return { ok: true as const };
    });
  }

  private async finishRevocation(actor: string, entry: Entry) {
    if (!entry.revoking) return;
    const accepted = await this.room(entry.room, entry.userRoom).cancelReservation(
      actor,
      true,
      entry.generation,
      entry.revoking,
    );
    if (!accepted) throw new Error('REVOCATION_FAILED');
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const current = queue.actors[actor];
      if (
        current &&
        current.generation === entry.generation &&
        current.revoking === entry.revoking
      )
        delete current.revoking;
      await this.write(queue);
    });
  }

  async cancelAdmission(
    actor: string,
    operationId: string,
    instanceId?: string,
    mode?: 'casual' | 'room',
  ) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      if (queue.admitting[actor]?.operationId === operationId)
        delete queue.admitting[actor];
      const receipts = await this.admissionReceipts(actor);
      const receipt = receipts[operationId] ?? {
        expires: Date.now() + settings.lobby.sessionLifetimeMs,
      };
      const entry = [queue.actors[actor]].find(
        (entry) =>
          entry?.operationId === operationId &&
          !!entry.userRoom === (mode === 'room') &&
          entry.scope.id === instanceId &&
          entry.scope.mode === mode,
      );
      if (
        entry?.operationId === operationId &&
        !!entry.userRoom === (mode === 'room') &&
        entry.scope.id === instanceId &&
        entry.scope.mode === mode &&
        (!receipt.generation || receipt.generation === entry.generation)
      )
        receipt.cancelling = entry;
      receipt.closed = true;
      receipts[operationId] = receipt;
      await this.ctx.storage.put(`admissions:${actor}`, receipts);
      await this.write(queue);
    });
    return this.finishWaitingCancel(actor, operationId);
  }

  private async finishWaitingCancel(actor: string, operationId: string) {
    const receipt = (await this.admissionReceipts(actor))?.[operationId];
    const entry = receipt?.cancelling;
    if (!entry) return { ok: true as const };
    const accepted = await this.room(entry.room, entry.userRoom)
      .cancelReservation(actor, false, entry.generation, entry.token, false)
      .catch(() => null);
    if (accepted === null)
      return { ok: false as const, code: 'GAME_DATABASE_UNAVAILABLE' };
    await this.ctx.blockConcurrencyWhile(async () => {
      const receipts = await this.admissionReceipts(actor);
      const saved = receipts[operationId];
      if (saved?.cancelling && saved.cancelling.generation === entry.generation)
        delete saved.cancelling;
      await this.ctx.storage.put(`admissions:${actor}`, receipts);
      const queue = await this.read();
      if (
        accepted &&
        queue.actors[actor] &&
        queue.actors[actor].generation === entry.generation
      ) {
        delete queue.actors[actor];
        await this.ctx.storage.delete(`definition:${entry.generation}`);
      }
      await this.write(queue);
    });
    return accepted
      ? { ok: true as const }
      : {
          ok: false as const,
          code: 'MATCH_STARTED',
          room: entry.room,
          instanceId: entry.scope.id,
        };
  }

  async logoutActor(actor: string, cookieRooms: string[] = []) {
    // Keep all logout requests for one actor ordered, including their cookie rooms.
    // Admission stays blocked until the last queued request completes.
    const previous = this.logouts.get(actor);
    const operation = (async () => {
      await previous?.catch(() => {});
      return this.logoutActorSessions(actor, cookieRooms);
    })();
    this.logouts.set(actor, operation);
    try {
      return await operation;
    } finally {
      if (this.logouts.get(actor) === operation) this.logouts.delete(actor);
    }
  }

  private async logoutActorSessions(actor: string, cookieRooms: string[]) {
    const { entry } = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const alreadyLoggingOut = queue.loggingOut[actor];
      queue.loggingOut[actor] = true;
      delete queue.admitting[actor];
      const entry = queue.actors[actor];
      for (const foreign of queue.foreign[actor] ?? []) {
        foreign.authenticated = false;
        foreign.logoutPending = true;
      }
      if (entry && !entry.revoking && !alreadyLoggingOut) {
        entry.revoking = entry.token;
        entry.token = crypto.randomUUID() + crypto.randomUUID();
      }
      await this.write(queue);
      return { entry };
    });
    if (entry) await this.finishRevocation(actor, entry);
    await this.finishForeignLogouts(actor);
    const receipts =
      (await this.ctx.storage.get<Record<string, number>>(`sessions:${actor}`)) ?? {};
    const rooms = new Set([
      ...cookieRooms,
      ...Object.keys(receipts).filter((room) => receipts[room] > Date.now()),
    ]);
    if (entry) rooms.delete(entry.userRoom ? `room:${entry.room}` : entry.room);
    await Promise.all(
      [...rooms].map((room) =>
        this.room(
          room.startsWith('room:') ? room.slice(5) : room,
          room.startsWith('room:'),
        ).cancelReservation(actor, true),
      ),
    );
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      delete queue.loggingOut[actor];
      await this.ctx.storage.delete(`sessions:${actor}`);
      // Retain the active room for later logout, even if no cookie reached the browser.
      if (entry)
        await this.ctx.storage.put(`sessions:${actor}`, {
          [entry.userRoom ? `room:${entry.room}` : entry.room]:
            Date.now() + settings.lobby.sessionLifetimeMs,
        });
      await this.write(queue);
    });
    return { ok: true as const };
  }

  async refreshWaiting(actor: string, instanceId: string) {
    await this.clean(actor, instanceId);
  }

  async refreshInstanceWaiting(instanceId: string) {
    await this.clean(undefined, instanceId);
  }

  async beginWithdrawal(actor: string, operationId: string) {
    await this.cleanForeign(actor);
    const blocked = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      if (queue.withdrawals[actor] && queue.withdrawals[actor] !== operationId)
        return true;
      queue.withdrawals[actor] = operationId;
      delete queue.admitting[actor];
      await this.write(queue);
      return false;
    });
    if (blocked) return { ok: false as const, code: 'WITHDRAWAL_PENDING' };
    await this.clean(actor);
    if (
      (await this.read()).foreign[actor]?.length ||
      (await this.read()).foreignDepartures[actor]
    )
      return { ok: false as const, code: 'CANCEL_WAITING_FIRST' };
    const entry = (await this.read()).actors[actor];
    if (!entry) return { ok: true as const };
    const status = await this.status(entry.room, entry.userRoom);
    return {
      ok: false as const,
      code: status?.phase === 'WAITING' ? 'CANCEL_WAITING_FIRST' : 'MATCH_STARTED',
    };
  }

  async cancelWithdrawal(actor: string, operationId: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      if (queue.withdrawals[actor] === operationId) delete queue.withdrawals[actor];
      await this.write(queue);
    });
  }

  async anonymizeAccount(actorId: string, questionIds: string[]) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      const entries = [...Object.entries(queue.actors)];
      for (const [id, entry] of entries) {
        if (id === actorId) entry.name = '退会ユーザー';
        if (entry.pending === true) {
          const key = `definition:${entry.generation}`;
          const definition = await this.ctx.storage.get<MatchDefinition>(key);
          if (definition) {
            anonymizeDefinition(definition, new Set(questionIds));
            await this.ctx.storage.put(key, definition);
          }
        } else if (entry.pending)
          anonymizeDefinition(entry.pending, new Set(questionIds));
      }
      await this.write(queue);
    });
  }

  private async status(room: string, userRoom = false) {
    let timer: number | undefined;
    try {
      return await Promise.race([
        this.room(room, userRoom).lobbyStatus(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, 3000);
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async alarm() {
    const queue = await this.read();
    // Bound external status/release traffic per invocation. The slot remains
    // occupied through an unknown response, including after the lease expires.
    const [foreignActor] = [
      ...new Set([
        ...Object.keys(queue.foreign),
        ...Object.keys(queue.foreignDepartures),
      ]),
    ].sort(
      (left, right) =>
        (queue.foreignChecked[left] ?? 0) - (queue.foreignChecked[right] ?? 0),
    );
    if (foreignActor) await this.cleanForeign(foreignActor);
    const receiptCursor = await this.ctx.storage.get<string>('foreign-receipt-cursor');
    const receipts = await this.ctx.storage.list<{ expiresAt: number }>({
      prefix: 'foreign-admission:',
      ...(receiptCursor ? { startAfter: receiptCursor } : {}),
      limit: 50,
    });
    for (const [key, receipt] of receipts)
      if (receipt.expiresAt <= Date.now()) await this.ctx.storage.delete(key);
    if (receipts.size === 50)
      await this.ctx.storage.put('foreign-receipt-cursor', [...receipts.keys()].at(-1));
    else await this.ctx.storage.delete('foreign-receipt-cursor');
    const operations = await this.ctx.storage.list<Record<string, AdmissionReceipt>>({
      prefix: 'admissions:',
    });
    for (const [key, receipts] of operations) {
      for (const [id, receipt] of Object.entries(receipts))
        if (receipt.cancelling)
          await this.finishWaitingCancel(key.slice('admissions:'.length), id).catch(
            () => {},
          );
      await this.ctx.blockConcurrencyWhile(async () => {
        const current =
          (await this.ctx.storage.get<Record<string, AdmissionReceipt>>(key)) ?? {};
        for (const [id, receipt] of Object.entries(current))
          if (receipt.expires <= Date.now() && !receipt.cancelling) delete current[id];
        if (Object.keys(current).length) await this.ctx.storage.put(key, current);
        else await this.ctx.storage.delete(key);
      });
    }
    for (const [actor, entry] of Object.entries(queue.actors)) {
      if (
        !entry.pending ||
        entry.created + settings.lobby.reservationLifetimeMs > Date.now()
      )
        continue;
      await this.cancel(actor, entry.room, false, entry.scope.id).catch(() => {});
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.read();
      for (const [actor, admission] of Object.entries(current.admitting))
        if (admission.expires <= Date.now()) delete current.admitting[actor];
      await this.write(current);
    });
  }

  private slotCount(queue: Queue, actor: string) {
    const local = [queue.actors[actor], queue.foreignDepartures[actor]].filter(
      (entry): entry is Entry => !!entry,
    );
    return (
      new Set(local.map((entry) => entry.generation)).size +
      (queue.foreign[actor]?.length ?? 0)
    );
  }
  async claimForeign(
    actor: string,
    target: ParticipationTarget,
    operationId: string,
    name: string,
  ) {
    await this.clean(actor);
    await this.cleanForeign(actor);
    if (!(await this.admissionAllowed(actor)))
      return { ok: false as const, code: 'RATE_LIMIT' };
    const requestHash = await contentHash(target);
    return this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      if (queue.withdrawals[actor])
        return { ok: false as const, code: 'WITHDRAWAL_PENDING' };
      if (queue.loggingOut[actor] || this.logouts.has(actor))
        return { ok: false as const, code: 'LOGOUT_PENDING' };

      const receipt = await this.ctx.storage.get<{ hash: string; closed?: boolean }>(
        `foreign-admission:${actor}:${operationId}`,
      );
      const existing = queue.foreign[actor]?.find(
        (entry) => entry.operationId === operationId,
      );
      if (receipt) {
        if (receipt.hash !== requestHash)
          return { ok: false as const, code: 'OPERATION_CONFLICT' };
        if (receipt.closed || !existing || existing.state === 'releasing')
          return { ok: false as const, code: 'STALE_REQUEST' };
        if (existing.logoutPending) return { ok: false as const, code: 'LOGOUT_PENDING' };
        if (!existing.authenticated) {
          existing.authorizationId = crypto.randomUUID();
          existing.authenticated = true;
        }
        await this.write(queue);
        return {
          ok: true as const,
          name: existing.name,
          authorizationId: existing.authorizationId,
        };
      }
      if (existing) return { ok: false as const, code: 'STALE_REQUEST' };
      if (this.slotCount(queue, actor) >= 2)
        return { ok: false as const, code: 'MATCH_SWITCH_PENDING' };
      if (!queue.foreign[actor]) queue.foreign[actor] = [];
      const authorizationId = crypto.randomUUID();
      queue.foreign[actor].push({
        ...target,
        operationId,
        requestHash,
        name,
        createdAt: Date.now(),
        expiresAt: Date.now() + settings.lobby.reservationLifetimeMs,
        state: 'reserving',
        authorizationId,
        authenticated: true,
      });
      queue.foreignIntent[actor] = operationId;
      delete queue.admitting[actor];
      await this.ctx.storage.put(`foreign-admission:${actor}:${operationId}`, {
        hash: requestHash,
        expiresAt: Date.now() + settings.lobby.sessionLifetimeMs,
      });
      await this.write(queue);
      return { ok: true as const, name, authorizationId };
    });
  }
  async commitForeign(
    actor: string,
    operationId: string,
    reservationId: string,
    expiresAt: number,
    authorizationId?: string,
  ) {
    const previous = await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read(),
        entry = queue.foreign[actor]?.find((entry) => entry.operationId === operationId);
      if (
        !entry?.authenticated ||
        entry.logoutPending ||
        (authorizationId !== undefined && entry.authorizationId !== authorizationId) ||
        entry.state === 'releasing' ||
        (entry.state === 'reserving' && entry.expiresAt <= Date.now())
      )
        return { ok: false as const, code: 'STALE_REQUEST' };
      if (queue.foreignIntent[actor] !== operationId) {
        if (entry.state === 'reserving') entry.state = 'releasing';
        await this.write(queue);
        return { ok: false as const, code: 'STALE_REQUEST' };
      }
      if (entry.reservationId && entry.reservationId !== reservationId)
        return { ok: false as const, code: 'OPERATION_CONFLICT' };
      entry.state = 'active';
      entry.reservationId = reservationId;
      if (queue.actors[actor]) {
        queue.foreignDepartures[actor] = queue.actors[actor];
      }
      entry.expiresAt = Math.min(
        expiresAt,
        entry.createdAt + settings.lobby.sessionLifetimeMs,
      );
      for (const old of queue.foreign[actor] ?? [])
        if (old.operationId !== operationId) {
          old.state = 'releasing';
          old.successor = operationId;
        }
      await this.write(queue);
      return { ok: true as const, local: queue.actors[actor] };
    });
    if (!previous.ok) return previous;
    await this.finishForeignDeparture(actor);
    await this.finishForeignReleases(actor);
    return { ok: true as const };
  }
  private async closeForeignEntry(actor: string, operationId: string) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read(),
        entry = queue.foreign[actor]?.find((entry) => entry.operationId === operationId);
      if (!entry) return;
      const foreign = queue.foreign;
      if (!foreign) return;
      const receipt = await this.ctx.storage.get<Record<string, unknown>>(
        `foreign-admission:${actor}:${operationId}`,
      );
      await this.ctx.storage.put(`foreign-admission:${actor}:${operationId}`, {
        ...receipt,
        closed: true,
      });
      foreign[actor] = foreign[actor].filter(
        (entry) => entry.operationId !== operationId,
      );
      if (!foreign[actor].length) delete foreign[actor];
      if (queue.foreignIntent[actor] === operationId) {
        const remaining = queue.foreign[actor]?.find((row) => row.state === 'active');
        if (remaining) queue.foreignIntent[actor] = remaining.operationId;
        else if (queue.actors[actor])
          queue.foreignIntent[actor] = `local:${queue.actors[actor].generation}`;
        else delete queue.foreignIntent[actor];
      }
      await this.write(queue);
    });
  }
  private async finishForeignReleases(actor: string) {
    for (const entry of (await this.read()).foreign[actor] ?? []) {
      if (entry.state !== 'releasing') continue;
      try {
        await releaseForeignEntry(this.env, actor, entry);
        await this.closeForeignEntry(actor, entry.operationId);
      } catch {
        /* Keep the slot and retry from Alarm. */
      }
    }
  }
  async foreignAuthorization(
    actor: string,
    operationId: string,
    authorizationId: string,
    target: ParticipationTarget,
  ) {
    const queue = await this.read(),
      entry = queue.foreign[actor]?.find((row) => row.operationId === operationId);
    return (
      !!entry &&
      entry.authenticated &&
      !entry.logoutPending &&
      entry.state !== 'releasing' &&
      entry.expiresAt > Date.now() &&
      entry.authorizationId === authorizationId &&
      entry.requestHash === (await contentHash(target)) &&
      !queue.loggingOut[actor] &&
      !queue.withdrawals[actor]
    );
  }
  async foreignContinuation(
    actor: string,
    operationId: string,
    target: ParticipationTarget,
  ) {
    const queue = await this.read(),
      entry = queue.foreign[actor]?.find((row) => row.operationId === operationId);
    return (
      !!entry &&
      entry.state === 'active' &&
      entry.expiresAt > Date.now() &&
      !entry.logoutPending &&
      !queue.loggingOut[actor] &&
      !queue.withdrawals[actor] &&
      entry.requestHash === (await contentHash(target))
    );
  }
  private async finishForeignLogouts(actor: string) {
    for (const entry of (await this.read()).foreign[actor] ?? []) {
      if (!entry.logoutPending || entry.state === 'releasing') continue;
      try {
        await logoutForeignEntry(this.env, actor, entry);
        await this.ctx.blockConcurrencyWhile(async () => {
          const queue = await this.read(),
            current = queue.foreign[actor]?.find(
              (row) => row.operationId === entry.operationId,
            );
          if (current?.authorizationId === entry.authorizationId)
            current.logoutPending = false;
          await this.write(queue);
        });
      } catch {
        /* Alarm retries; new authentication stays blocked until acknowledged. */
      }
    }
  }
  private async cleanForeign(actor: string) {
    const initial = await this.read(),
      entries = initial.foreign[actor] ?? [];
    if (!entries.length && !initial.foreignDepartures[actor]) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      queue.foreignChecked[actor] = Date.now();
      await this.write(queue);
    });
    for (const entry of entries) {
      if (entry.state === 'reserving' && entry.expiresAt <= Date.now())
        await this.ctx.blockConcurrencyWhile(async () => {
          const queue = await this.read(),
            current = queue.foreign[actor]?.find(
              (row) => row.operationId === entry.operationId,
            );
          if (current?.state === 'reserving') current.state = 'releasing';
          await this.write(queue);
        });
      if (entry.state === 'active')
        try {
          const status = await foreignEntryStatus(this.env, actor, entry);
          if (!status.active) await this.closeForeignEntry(actor, entry.operationId);
        } catch {
          /* An unknown status never frees a participation slot. */
        }
    }
    await this.finishForeignReleases(actor);
    await this.finishForeignLogouts(actor);
    await this.finishForeignDeparture(actor);
  }
  private async finishForeignDeparture(actor: string) {
    const previous = (await this.read()).foreignDepartures[actor];
    if (!previous) return;
    try {
      const closed = await this.room(previous.room, previous.userRoom).cancelReservation(
        actor,
        true,
        previous.generation,
        previous.revoking ?? previous.token,
        true,
      );
      if (!closed) return;
      await this.ctx.blockConcurrencyWhile(async () => {
        const queue = await this.read();
        if (
          queue.foreignDepartures[actor] &&
          queue.foreignDepartures[actor].generation === previous.generation
        ) {
          delete queue.foreignDepartures[actor];
          if (
            queue.actors[actor] &&
            queue.actors[actor].generation === previous.generation
          )
            delete queue.actors[actor];
          await this.ctx.storage.delete(`definition:${previous.generation}`);
        }
        await this.write(queue);
      });
    } catch {
      /* A departure is retained independently of the successor's lifetime. */
    }
  }
  private async stopWaiting(scope: InstanceScope, band?: number) {
    const queue = await this.read();
    const entries = Object.entries(queue.actors).filter(
      ([, entry]) =>
        entry.scope.id === scope.id &&
        entry.scope.mode === scope.mode &&
        !entry.userRoom &&
        (band === undefined || entry.band === band),
    );
    const rooms = [...new Set(entries.map(([, entry]) => entry.room))];
    await Promise.allSettled(rooms.map((id) => this.room(id).stopWaiting(scope.id)));
    await Promise.allSettled(
      entries.map(async ([actor, entry]) => {
        if (
          !(await this.room(entry.room).cancelReservation(actor, false, entry.generation))
        )
          return;
        await this.ctx.blockConcurrencyWhile(async () => {
          const current = await this.read();
          if (
            current.actors[actor] &&
            current.actors[actor].generation === entry.generation
          ) {
            delete current.actors[actor];
            await this.ctx.storage.delete(`definition:${entry.generation}`);
          }
          await this.write(current);
        });
      }),
    );
  }
  private room(id: string, userRoom = false) {
    return this.env.GAME_ROOM.getByName(userRoom ? userRoomName(id) : matchRoomName(id));
  }
  private async read(): Promise<Queue> {
    return (
      (await this.ctx.storage.get<Queue>('queue')) ?? {
        actors: {},
        foreign: {},
        foreignIntent: {},
        foreignDepartures: {},
        foreignChecked: {},
        withdrawals: {},
        loggingOut: {},
        admitting: {},
      }
    );
  }
  private async write(queue: Queue) {
    for (const actor of Object.keys(queue.foreignIntent))
      if (!queue.foreign[actor]?.length) delete queue.foreignIntent[actor];
    for (const actor of Object.keys(queue.foreignChecked))
      if (!queue.foreign[actor]?.length && !queue.foreignDepartures[actor])
        delete queue.foreignChecked[actor];
    await this.ctx.storage.put('queue', queue);
    const deadlines = Object.values(queue.admitting).map((item) => item.expires);
    for (const entry of Object.values(queue.actors))
      if (entry.pending)
        deadlines.push(entry.created + settings.lobby.reservationLifetimeMs);
    for (const entries of Object.values(queue.foreign))
      for (const entry of entries) deadlines.push(entry.expiresAt);
    if (Object.keys(queue.foreignDepartures).length)
      deadlines.push(Date.now() + settings.results.retryIntervalMs);
    const receipts = await this.ctx.storage.list<Record<string, AdmissionReceipt>>({
      prefix: 'admissions:',
    });
    for (const operations of receipts.values())
      for (const receipt of Object.values(operations))
        deadlines.push(
          receipt.cancelling
            ? Date.now() + settings.results.retryIntervalMs
            : receipt.expires,
        );
    const foreignReceipts = await this.ctx.storage.list<{ expiresAt: number }>({
      prefix: 'foreign-admission:',
    });
    for (const receipt of foreignReceipts.values()) deadlines.push(receipt.expiresAt);
    if (deadlines.length)
      await this.ctx.storage.setAlarm(
        Math.min(...deadlines) <= Date.now()
          ? Date.now() + settings.results.retryIntervalMs
          : Math.min(...deadlines),
      );
    else await this.ctx.storage.deleteAlarm();
  }

  private async admissionReceipts(actor: string) {
    const key = `admissions:${actor}`;
    const receipts =
      (await this.ctx.storage.get<Record<string, AdmissionReceipt>>(key)) ?? {};
    let expired = false;
    for (const [id, receipt] of Object.entries(receipts)) {
      if (receipt.expires > Date.now() || receipt.cancelling) continue;
      delete receipts[id];
      expired = true;
    }
    if (expired) {
      if (Object.keys(receipts).length) await this.ctx.storage.put(key, receipts);
      else await this.ctx.storage.delete(key);
    }
    return receipts;
  }
  private async admissionAllowed(actor: string) {
    if (!this.env.ADMISSION_LIMITER) throw new Error('RATE_LIMITER_NOT_CONFIGURED');
    return (await this.env.ADMISSION_LIMITER.limit({ key: actor })).success;
  }
  private async clean(actorId?: string, instanceId?: string) {
    const snapshot = await this.read();
    if (instanceId !== undefined)
      snapshot.actors = Object.fromEntries(
        Object.entries(snapshot.actors).filter(
          ([, entry]) => entry.scope.id === instanceId,
        ),
      );
    if (actorId)
      snapshot.actors = snapshot.actors[actorId]
        ? { [actorId]: snapshot.actors[actorId] }
        : {};
    const rooms = [...new Set(Object.values(snapshot.actors).map((entry) => entry.room))];
    const statuses = new Map(
      await Promise.all(
        rooms.map(async (room) => {
          try {
            return [
              room,
              await this.status(
                room,
                Object.values(snapshot.actors).find((entry) => entry.room === room)
                  ?.userRoom,
              ),
            ] as const;
          } catch {
            return [room, undefined] as const;
          }
        }),
      ),
    );
    const released: [string, Entry][] = [];
    await Promise.all(
      Object.entries(snapshot.actors).map(async ([actor, entry]) => {
        const status = statuses.get(entry.room);
        if (status === undefined) return; // Unknown is never proof of completion.
        if (status?.phase === 'FINISHED' || status?.phase === 'INVALID') return; // D1 completion is acknowledged by matchFinished.
        if (
          entry.pending &&
          !status?.actors.includes(actor) &&
          Date.now() < entry.created + settings.lobby.reservationLifetimeMs
        )
          return;
        if (!status || status.closed || !status.actors.includes(actor)) {
          try {
            // Fence the generation before releasing the actor, including delayed reserve RPCs.
            if (
              await this.room(entry.room, entry.userRoom).cancelReservation(
                actor,
                false,
                entry.generation,
              )
            )
              released.push([actor, entry]);
          } catch {
            /* Keep the reservation for reconciliation. */
          }
        }
      }),
    );
    await this.ctx.blockConcurrencyWhile(async () => {
      const queue = await this.read();
      for (const [actor, entry] of released) {
        const current = queue.actors[actor];
        if (
          current &&
          current.generation === entry.generation &&
          current.token === entry.token
        ) {
          delete queue.actors[actor];
          await this.ctx.storage.delete(`definition:${entry.generation}`);
        }
      }
      for (const [id, item] of Object.entries(queue.admitting))
        if (item.expires <= Date.now()) delete queue.admitting[id];
      await this.write(queue);
    });
  }
}
